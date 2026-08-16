'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { comment } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const ENTITY_TYPES = ['project', 'task', 'company'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

export async function addCommentAction(
  entityType: EntityType,
  entityId: string,
  path: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { error: 'Write something first.' };
  if (!ENTITY_TYPES.includes(entityType)) return { error: 'Unknown target.' };

  try {
    await withUser(async (tx, user) => {
      await tx.insert(comment).values({
        entityType,
        entityId,
        // The RLS policy requires this to be the session user — a forged
        // author_id is refused by the database, not just by this line.
        authorId: user.id,
        authorName: user.name,
        body,
      });
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath(path);
  return EMPTY_STATE;
}

export async function deleteCommentAction(path: string, formData: FormData): Promise<void> {
  const id = String(formData.get('commentId') ?? '');
  if (!id) return;
  // Author or admin only — decided by the policy, not here.
  await withUser(async (tx) => {
    await tx.delete(comment).where(eq(comment.id, id));
  });
  revalidatePath(path);
}
