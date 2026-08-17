'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { attachment } from '@/db/schema';
import { withUser } from '@/db/session';
import { removeStored, storeUpload } from '@/lib/uploads';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const ENTITIES = ['task', 'project', 'company', 'contact', 'document', 'finance_entry'] as const;
type EntityType = (typeof ENTITIES)[number];

/**
 * Attaches a file to a record.
 *
 * The file is written first, then the row. If the row fails — RLS, a CHECK, a
 * duplicate — the file is removed again, so the volume never accumulates bytes
 * with nothing pointing at them.
 */
export async function uploadAttachmentAction(
  entityType: EntityType,
  entityId: string,
  revalidate: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!ENTITIES.includes(entityType)) return { error: 'Unknown attachment target.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a file first.' };
  }

  const caption = String(formData.get('caption') ?? '').trim() || null;

  let stored;
  try {
    stored = await storeUpload(file);
  } catch (error) {
    // storeUpload throws messages written for the user.
    return { error: error instanceof Error ? error.message : 'That file could not be stored.' };
  }

  try {
    await withUser(async (tx, user) => {
      await tx.insert(attachment).values({
        entityType,
        entityId,
        originalName: file.name.slice(0, 255),
        storedPath: stored.storedPath,
        mimeType: stored.mimeType,
        sizeBytes: BigInt(stored.sizeBytes),
        caption,
        uploadedById: user.id,
      });
    });
  } catch (error) {
    // The row did not land, so neither should the bytes.
    await removeStored(stored.storedPath);
    return { error: describeDbError(error) };
  }

  revalidatePath(revalidate);
  return EMPTY_STATE;
}

export async function deleteAttachmentAction(formData: FormData): Promise<void> {
  const id = String(formData.get('attachmentId') ?? '');
  const revalidate = String(formData.get('revalidate') ?? '/');
  if (!id) return;

  // The RLS policy decides whether this session may delete it. Only remove the
  // file if a row actually came back — otherwise the delete was refused and the
  // file still belongs to a live record.
  const removed = await withUser(async (tx) => {
    const rows = await tx
      .delete(attachment)
      .where(eq(attachment.id, id))
      .returning({ storedPath: attachment.storedPath });
    return rows[0]?.storedPath ?? null;
  });

  if (removed) await removeStored(removed);
  revalidatePath(revalidate);
}

/** Attachments for one record, newest first. */
export async function listAttachments(entityType: EntityType, entityId: string) {
  return withUser(async (tx) =>
    tx
      .select()
      .from(attachment)
      .where(and(eq(attachment.entityType, entityType), eq(attachment.entityId, entityId)))
      .orderBy(attachment.createdAt),
  );
}
