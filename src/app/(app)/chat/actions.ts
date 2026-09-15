'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { message, thread, threadRead } from '@/db/schema';
import { withUser } from '@/db/session';
import { removeStored, storeUpload } from '@/lib/uploads';
import { attachment } from '@/db/schema';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Team chat.
 *
 * No role checks here. Who may see a thread, who may post in one, and who may
 * edit a message are all row level security policies — which is where a rule
 * about rows belongs. An action that decided any of it again would be a second
 * copy, free to drift from the first.
 */

const CHAT_ERRORS = {
  thread_title_present: 'Give the thread a name.',
  thread_kind_valid: 'A thread is general, about a client, or about a project.',
  thread_target_matches_kind: 'That thread kind does not match what it points at.',
  message_body_present: 'Write something first.',
};

export async function createThreadAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const kind = String(formData.get('kind') ?? 'general');
  const title = String(formData.get('title') ?? '').trim();
  const target = String(formData.get('targetId') ?? '').trim() || null;

  if (!title) return { error: 'Give the thread a name.' };
  if (!['general', 'company', 'project'].includes(kind)) {
    return { error: 'A thread is general, about a client, or about a project.' };
  }
  if (kind !== 'general' && !target) {
    return { error: kind === 'company' ? 'Which client?' : 'Which project?' };
  }

  let newId: string;
  try {
    newId = await withUser(async (tx, user) => {
      const [row] = await tx
        .insert(thread)
        .values({
          kind,
          title,
          companyId: kind === 'company' ? target : null,
          projectId: kind === 'project' ? target : null,
          createdById: user.id,
        })
        .returning({ id: thread.id });
      if (!row) throw new Error('The thread could not be created.');
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error, CHAT_ERRORS) };
  }

  revalidatePath('/chat');
  redirect(`/chat/${newId}`);
}

/**
 * Post a message, optionally with one file.
 *
 * The message row goes in first and the file second, so an attachment can
 * never exist pointing at a message that was refused. If the file then fails —
 * too big, wrong type, disk — the message stands and the sender is told; a
 * post that silently vanished because its attachment was rejected would be
 * worse than one that arrives without it.
 */
export async function postMessageAction(
  threadId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const body = String(formData.get('body') ?? '').trim();
  const file = formData.get('file');
  const hasFile = file instanceof File && file.size > 0;

  if (!body && !hasFile) return { error: 'Write something, or attach a file.' };

  let messageId: string;
  try {
    messageId = await withUser(async (tx, user) => {
      const [row] = await tx
        .insert(message)
        .values({
          threadId,
          authorId: user.id,
          authorName: user.name ?? 'Someone',
          body: body || '(file)',
        })
        .returning({ id: message.id });
      if (!row) throw new Error('The message could not be posted.');
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error, CHAT_ERRORS) };
  }

  if (hasFile) {
    let stored;
    try {
      // Ceiling and whitelist are enforced in here, server-side, whatever the
      // browser was told to accept.
      stored = await storeUpload(file);
    } catch (error) {
      revalidatePath(`/chat/${threadId}`);
      return {
        error: `Message sent, but the file was not: ${
          error instanceof Error ? error.message : 'it could not be stored.'
        }`,
      };
    }

    try {
      await withUser(async (tx, user) => {
        await tx.insert(attachment).values({
          entityType: 'message',
          entityId: messageId,
          originalName: file.name,
          storedPath: stored.storedPath,
          mimeType: stored.mimeType,
          sizeBytes: BigInt(stored.sizeBytes),
          uploadedById: user.id,
        });
      });
    } catch (error) {
      // The row failed, so the bytes have nothing pointing at them.
      await removeStored(stored.storedPath);
      revalidatePath(`/chat/${threadId}`);
      return { error: `Message sent, but the file was not: ${describeDbError(error, {})}` };
    }
  }

  revalidatePath('/chat');
  revalidatePath(`/chat/${threadId}`);
  return EMPTY_STATE;
}

/**
 * Correct a typo. The fifteen-minute window and the "only the text" rule are
 * both enforced by a trigger, so this does not restate them.
 */
export async function editMessageAction(
  threadId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get('messageId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!id) return { error: 'Which message?' };
  if (!body) return { error: 'A message cannot be emptied. It can only be corrected.' };

  try {
    await withUser(async (tx) => {
      await tx.update(message).set({ body }).where(eq(message.id, id));
    });
  } catch (error) {
    return { error: describeDbError(error, CHAT_ERRORS) };
  }

  revalidatePath(`/chat/${threadId}`);
  return EMPTY_STATE;
}

/** Mark the thread read up to now, for this person only. */
export async function markThreadReadAction(threadId: string): Promise<void> {
  await withUser(async (tx, user) => {
    await tx
      .insert(threadRead)
      .values({ threadId, userId: user.id })
      .onConflictDoUpdate({
        target: [threadRead.threadId, threadRead.userId],
        set: { lastReadAt: sql`now()` },
      });
  });
  revalidatePath('/chat');
}
