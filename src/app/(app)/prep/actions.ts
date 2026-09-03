'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prep } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * The prep board.
 *
 * None of these actions checks a role: the rules are row level security
 * policies, which is the right place for them because "only the owner, unless
 * it is ready" is a statement about rows. An action that also tried to decide
 * it would be a second copy of the rule, free to drift from the first.
 */

const PREP_ERRORS = {
  prep_title_present: 'Give it a name — even a rough one.',
  prep_kind_valid: 'Pick what kind of preparation this is.',
  prep_status_valid: 'A piece of prep is either a draft or ready.',
};

const KINDS = ['idea', 'script', 'shotlist', 'moodboard', 'location', 'music', 'other'];

export async function createPrepAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const title = String(formData.get('title') ?? '').trim();
  const kind = String(formData.get('kind') ?? 'idea');
  const body = String(formData.get('body') ?? '').trim() || null;
  const projectId = String(formData.get('projectId') ?? '').trim() || null;

  if (!title) return { error: 'Give it a name — even a rough one.' };
  if (!KINDS.includes(kind)) return { error: 'Pick what kind of preparation this is.' };

  let newId: string;
  try {
    newId = await withUser(async (tx, user) => {
      const [row] = await tx
        .insert(prep)
        .values({ title, kind, body, projectId, ownerId: user.id })
        .returning({ id: prep.id });
      if (!row) throw new Error('It could not be created.');
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error, PREP_ERRORS) };
  }

  revalidatePath('/prep');
  redirect(`/prep/${newId}`);
}

/** Edit. The policy already restricts this to the owner. */
export async function updatePrepAction(
  prepId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const title = String(formData.get('title') ?? '').trim();
  const kind = String(formData.get('kind') ?? 'idea');
  const body = String(formData.get('body') ?? '').trim() || null;
  const projectId = String(formData.get('projectId') ?? '').trim() || null;

  if (!title) return { error: 'Give it a name — even a rough one.' };
  if (!KINDS.includes(kind)) return { error: 'Pick what kind of preparation this is.' };

  try {
    await withUser(async (tx) => {
      await tx.update(prep).set({ title, kind, body, projectId }).where(eq(prep.id, prepId));
    });
  } catch (error) {
    return { error: describeDbError(error, PREP_ERRORS) };
  }

  revalidatePath('/prep');
  revalidatePath(`/prep/${prepId}`);
  return EMPTY_STATE;
}

/**
 * Share it, or pull it back.
 *
 * Pulling back is allowed on purpose: it is the owner's work, and preparation
 * shared before it was finished should be retrievable. The trigger clears
 * ready_at so nothing later claims it was shared while it was not.
 */
export async function setPrepStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('prepId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!id || !['draft', 'ready'].includes(status)) return;

  await withUser(async (tx) => {
    await tx.update(prep).set({ status }).where(eq(prep.id, id));
  });

  revalidatePath('/prep');
  revalidatePath(`/prep/${id}`);
}

export async function deletePrepAction(formData: FormData): Promise<void> {
  const id = String(formData.get('prepId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx.delete(prep).where(eq(prep.id, id));
  });
  revalidatePath('/prep');
  redirect('/prep');
}
