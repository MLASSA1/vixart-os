'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/** The longest thing a client can send in one go. */
const MAX = 4000;

/**
 * A client writes to the team.
 *
 * Note what is NOT here: no thread id from the form, and no company. The
 * thread is looked up on the client's own connection, where exactly one
 * support thread is visible — their own. A thread id taken from a form would
 * be a number the browser chooses, and the only thing standing between it and
 * another client's conversation would be a check in this file.
 *
 * `author_contact_id` is set from the session and `author_id` left null; the
 * policy in 0064 requires both, so a message cannot be attributed to VIXART
 * from here even if this code tried.
 */
export async function sendSupportMessageAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) {
    return { error: 'Choose your password first.' };
  }

  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { error: 'Write something first.' };
  if (body.length > MAX) {
    return { error: `That is longer than ${MAX} characters. Send it in two parts.` };
  }

  try {
    await withClient(session.user.id, async (tx) => {
      const thread = await tx.execute<{ id: string }>(sql`
        SELECT id FROM thread WHERE kind = 'support' LIMIT 1
      `);
      const id = thread.rows[0]?.id;
      if (!id) throw new Error('This conversation is not open yet. Please email us.');

      await tx.execute(sql`
        INSERT INTO message (thread_id, author_contact_id, author_name, body)
        VALUES (${id}, ${session.user.id}, ${session.user.name ?? 'Client'}, ${body})
      `);
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath('/portal/support');
  return EMPTY_STATE;
}
