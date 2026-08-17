'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { financeEntry, recurringEntry } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes } from '@/lib/money';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const FINANCE_ERRORS = {
  finance_amount_positive:
    'Enter a positive amount — whether it is money in or out is the direction, not the sign.',
  finance_vat_range: 'The VAT cannot be more than the amount itself.',
  finance_one_line_per_document: 'That invoice is already in the ledger.',
};

const entrySchema = z.object({
  direction: z.enum(['income', 'expense']),
  category: z.string().trim().min(1),
  paymentMethod: z.enum(['virement', 'especes', 'cheque', 'carte', 'autre']),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.'),
  description: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  reference: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  companyId: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

/**
 * Records a movement by hand. Invoice revenue is not entered here — it is
 * posted by a trigger when the invoice is marked paid, so the ledger cannot
 * disagree with the invoices.
 */
export async function addEntryAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = entrySchema.safeParse({
    direction: formData.get('direction') ?? 'expense',
    category: formData.get('category') ?? '',
    paymentMethod: formData.get('paymentMethod') ?? 'virement',
    entryDate: formData.get('entryDate') ?? '',
    description: formData.get('description') ?? '',
    reference: formData.get('reference') ?? '',
    companyId: formData.get('companyId') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  let amount: bigint;
  let vat = 0n;
  try {
    amount = toCentimes(String(formData.get('amount') ?? ''));
    const rawVat = String(formData.get('vat') ?? '').trim();
    if (rawVat !== '') vat = toCentimes(rawVat);
  } catch {
    return { error: 'The amount could not be read. Use a figure like 1 500 or 1500,50.' };
  }
  if (amount <= 0n) return { error: 'The amount must be greater than zero.' };
  if (vat < 0n || vat > amount) return { error: 'The VAT cannot be more than the amount.' };

  try {
    await withUser(async (tx, user) => {
      await tx.insert(financeEntry).values({
        ...parsed.data,
        amountCentimes: amount,
        vatCentimes: vat,
        isAutomatic: false,
        recordedById: user.id,
      });
    });
  } catch (error) {
    return { error: describeDbError(error, FINANCE_ERRORS) };
  }

  revalidatePath('/finance');
  revalidatePath('/dashboard');
  return EMPTY_STATE;
}

export async function deleteEntryAction(formData: FormData): Promise<void> {
  const id = String(formData.get('entryId') ?? '');
  if (!id) return;
  // An automatic line is the record of a paid invoice; removing it by hand
  // would make the ledger and the invoices disagree. Only hand-entered lines
  // can be deleted here.
  await withUser(async (tx) => {
    await tx
      .delete(financeEntry)
      .where(and(eq(financeEntry.id, id), eq(financeEntry.isAutomatic, false)));
  });
  revalidatePath('/finance');
  revalidatePath('/dashboard');
}

// ---------------------------------------------------------------------------
// Recurring costs
// ---------------------------------------------------------------------------

const recurringSchema = z.object({
  direction: z.enum(['income', 'expense']),
  category: z.string().trim().min(1),
  paymentMethod: z.enum(['virement', 'especes', 'cheque', 'carte', 'autre']),
  description: z.string().trim().min(1, 'Say what the cost is.'),
  frequency: z.enum(['monthly', 'quarterly', 'yearly']),
  dayOfMonth: z.coerce.number().int().min(1).max(28),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date.'),
  endDate: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

/**
 * Creates a template and immediately posts anything already due, so a cost
 * backdated to January lands as seven lines rather than waiting for tonight.
 */
export async function addRecurringAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = recurringSchema.safeParse({
    direction: formData.get('direction') ?? 'expense',
    category: formData.get('category') ?? '',
    paymentMethod: formData.get('paymentMethod') ?? 'virement',
    description: formData.get('description') ?? '',
    frequency: formData.get('frequency') ?? 'monthly',
    dayOfMonth: formData.get('dayOfMonth') ?? 1,
    startDate: formData.get('startDate') ?? '',
    endDate: formData.get('endDate') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  let amount: bigint;
  let vat = 0n;
  try {
    amount = toCentimes(String(formData.get('amount') ?? ''));
    const rawVat = String(formData.get('vat') ?? '').trim();
    if (rawVat !== '') vat = toCentimes(rawVat);
  } catch {
    return { error: 'The amount could not be read. Use a figure like 6 000 or 6000,50.' };
  }
  if (amount <= 0n) return { error: 'The amount must be greater than zero.' };
  if (vat < 0n || vat > amount) return { error: 'The VAT cannot be more than the amount.' };

  try {
    await withUser(async (tx, user) => {
      await tx.insert(recurringEntry).values({
        ...parsed.data,
        amountCentimes: amount,
        vatCentimes: vat,
        createdById: user.id,
      });
      await tx.execute(sql`SELECT app.post_due_recurring()`);
    });
  } catch (error) {
    return { error: describeDbError(error, FINANCE_ERRORS) };
  }

  revalidatePath('/finance');
  revalidatePath('/dashboard');
  return EMPTY_STATE;
}

/**
 * Stops or restarts a template. Lines already posted stay — they record money
 * that actually moved.
 */
export async function toggleRecurringAction(formData: FormData): Promise<void> {
  const id = String(formData.get('recurringId') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';
  if (!id) return;
  await withUser(async (tx) => {
    await tx.update(recurringEntry).set({ isActive: active }).where(eq(recurringEntry.id, id));
    if (active) await tx.execute(sql`SELECT app.post_due_recurring()`);
  });
  revalidatePath('/finance');
}

export async function deleteRecurringAction(formData: FormData): Promise<void> {
  const id = String(formData.get('recurringId') ?? '');
  if (!id) return;
  // The ledger lines survive: finance_entry.recurring_entry_id is ON DELETE
  // SET NULL, so past months keep their record of money that really moved.
  await withUser(async (tx) => {
    await tx.delete(recurringEntry).where(eq(recurringEntry.id, id));
  });
  revalidatePath('/finance');
}

/** Runs the catch-up by hand. The nightly job does this anyway. */
export async function postDueNowAction(): Promise<void> {
  await withUser(async (tx) => {
    await tx.execute(sql`SELECT app.post_due_recurring()`);
  });
  revalidatePath('/finance');
  revalidatePath('/dashboard');
}
