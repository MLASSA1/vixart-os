'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { privateNote } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Private notes.
 *
 * Nothing here checks who is asking. `private_note_own` restricts every row to
 * its author in both directions, and there is no bootstrap policy — so no part
 * of this application can read somebody else's notes, whatever it forgets to
 * check. A note that could be read by the person who runs the agency is not
 * somewhere anyone would draft an unfinished thought.
 */

export async function saveNoteAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get('noteId') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const body = String(formData.get('body') ?? '');
  if (!title) return { error: 'Give it a title.' };

  try {
    await withUser(async (tx, user) => {
      if (id) {
        // Matches nothing if it is not yours; no ownership check is written
        // here, because the policy already is one.
        await tx.update(privateNote).set({ title, body }).where(eq(privateNote.id, id));
      } else {
        await tx.insert(privateNote).values({ authorId: user.id, title, body });
      }
    });
  } catch (error) {
    return { error: describeDbError(error, {}) };
  }

  revalidatePath('/notes');
  return EMPTY_STATE;
}

export async function deleteNoteAction(formData: FormData): Promise<void> {
  const id = String(formData.get('noteId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx.delete(privateNote).where(eq(privateNote.id, id));
  });
  revalidatePath('/notes');
}
