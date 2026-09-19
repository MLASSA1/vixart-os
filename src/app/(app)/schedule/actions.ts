'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { scheduleEntry } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Personal entries on somebody's own week.
 *
 * No role checks here. `schedule_entry_own` restricts every row to its owner
 * in both directions, so a colleague cannot read what you have booked and
 * cannot put something in your week on your behalf. That is where a rule about
 * rows belongs.
 */

const SCHEDULE_ERRORS = {
  schedule_title_present: 'Give it a name.',
  schedule_range_ordered: 'The end cannot be before the start.',
  schedule_kind_valid: 'Choose what kind of entry this is.',
};

const entrySchema = z.object({
  title: z.string().trim().min(1, 'Give it a name.'),
  kind: z.enum(['shoot', 'meeting', 'off', 'block']),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.'),
  endsOn: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'That end date is not a date.'),
  note: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

export async function addScheduleEntryAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = entrySchema.safeParse({
    title: formData.get('title') ?? '',
    kind: formData.get('kind') ?? 'block',
    startsOn: formData.get('startsOn') ?? '',
    endsOn: formData.get('endsOn') ?? '',
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  try {
    await withUser(async (tx, user) => {
      await tx.insert(scheduleEntry).values({ ...parsed.data, userId: user.id });
    });
  } catch (error) {
    return { error: describeDbError(error, SCHEDULE_ERRORS) };
  }

  revalidatePath('/schedule');
  return EMPTY_STATE;
}

/**
 * Remove one of your own entries.
 *
 * A personal entry is not a record of anything — it is a plan, and plans
 * change. Unlike a message or a task it carries no obligation to anybody else,
 * so it deletes outright rather than leaving a mark.
 */
export async function deleteScheduleEntryAction(formData: FormData): Promise<void> {
  const id = String(formData.get('entryId') ?? '');
  if (!id) return;

  await withUser(async (tx) => {
    // No ownership check: the policy allows the delete to match only your own
    // rows, so somebody else's id simply matches nothing.
    await tx.delete(scheduleEntry).where(eq(scheduleEntry.id, id));
  });

  revalidatePath('/schedule');
}
