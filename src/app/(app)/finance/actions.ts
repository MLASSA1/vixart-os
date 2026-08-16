'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { financeEntry } from '@/db/schema';
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
