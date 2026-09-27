'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { retainer } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes } from '@/lib/money';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Retainers — the agency's monthly contracts.
 *
 * No role checks here: `retainer_write` is `app.is_moderator()`, which is the
 * right place for a rule about rows. An action that decided it again would be
 * a second copy free to drift from the first.
 */

const RETAINER_ERRORS = {
  retainer_label_present: 'Give the contract a name — what the client is paying for.',
  retainer_monthly_positive: 'The monthly amount has to be above zero.',
  retainer_term_sane: 'A term is between 1 and 36 months.',
  retainer_billing_day_sane: 'Pick a billing day between 1 and 28 — February has to work too.',
  retainer_end_after_start: 'The end date has to be after the start.',
  retainer_ended_needs_reason: 'Say why it ended. Churn reason is the most useful thing this records.',
  retainer_status_valid: 'A retainer is active, paused or ended.',
  retainer_vat_sane: 'That VAT rate is not a rate.',
};

export async function createRetainerAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const companyId = String(formData.get('companyId') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const startDate = String(formData.get('startDate') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const autoRenew = String(formData.get('autoRenew') ?? '') === 'yes';

  if (!companyId) return { error: 'Pick a client.' };
  if (!label) return { error: 'Give the contract a name — what the client is paying for.' };
  if (!startDate) return { error: 'When does it start?' };

  let monthly: bigint;
  try {
    monthly = toCentimes(String(formData.get('monthly') ?? '').trim());
  } catch {
    return { error: 'The monthly amount could not be read. Use a figure like 6 000 or 6000,50.' };
  }
  if (monthly <= 0n) return { error: 'The monthly amount has to be above zero.' };

  const termMonths = Number(formData.get('termMonths') ?? 3);
  const billingDay = Number(formData.get('billingDay') ?? 1);
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 36) {
    return { error: 'A term is between 1 and 36 months.' };
  }
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) {
    return { error: 'Pick a billing day between 1 and 28 — February has to work too.' };
  }

  try {
    await withUser(async (tx, user) => {
      // The VAT rate in force today, frozen onto the contract. The rate can
      // change; what was agreed with this client did not.
      const rate = await tx.execute<{ bp: string }>(sql`
        SELECT coalesce((SELECT rate_bp FROM fiscal_rate
                          WHERE key='tva_standard' AND effective_from <= current_date
                          ORDER BY effective_from DESC LIMIT 1), 2000)::text AS bp
      `);

      await tx.insert(retainer).values({
        companyId,
        label,
        monthlyCentimes: monthly,
        vatRateBp: Number(rate.rows[0]?.bp ?? 2000),
        startDate,
        termMonths,
        autoRenew,
        billingDay,
        notes,
        createdById: user.id,
      });
    });
  } catch (error) {
    return { error: describeDbError(error, RETAINER_ERRORS) };
  }

  revalidatePath('/retainers');
  revalidatePath('/dashboard');
  return EMPTY_STATE;
}

/** Pause or resume. A paused retainer drafts nothing and counts nothing. */
export async function setRetainerStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('retainerId') ?? '');
  const status = String(formData.get('status') ?? '');
  // Ending goes through endRetainerAction, because it needs a reason.
  if (!id || !['active', 'paused'].includes(status)) return;

  await withUser(async (tx) => {
    await tx.update(retainer).set({ status }).where(eq(retainer.id, id));
  });

  revalidatePath('/retainers');
  revalidatePath('/dashboard');
}

/**
 * End it. Allowed inside a committed term — a client who wants to go will go,
 * and a system that refuses to record it just stops matching reality — but the
 * reason is mandatory, enforced by a CHECK rather than by this function.
 */
export async function endRetainerAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get('retainerId') ?? '');
  const reason = String(formData.get('endReason') ?? '').trim();
  const endedOn = String(formData.get('endedOn') ?? '').trim();
  if (!id) return { error: 'Which retainer?' };
  if (!reason) {
    return { error: 'Say why it ended. Churn reason is the most useful thing this records.' };
  }

  try {
    await withUser(async (tx) => {
      await tx
        .update(retainer)
        .set({
          status: 'ended',
          endReason: reason,
          endedOn: endedOn || undefined,
          // The contract stops here rather than at its natural expiry.
          endDate: endedOn || undefined,
        })
        .where(eq(retainer.id, id));
    });
  } catch (error) {
    return { error: describeDbError(error, RETAINER_ERRORS) };
  }

  revalidatePath('/retainers');
  revalidatePath('/dashboard');
  return EMPTY_STATE;
}

/**
 * Draft this month's invoices by hand.
 *
 * The nightly job does this anyway; the button exists for the day someone wants
 * them now. Idempotent by unique index, so pressing it twice is harmless.
 */
export async function draftRetainerInvoicesAction(): Promise<void> {
  await withUser(async (tx) => {
    await tx.execute(sql`SELECT app.draft_retainer_invoices()`);
  });
  revalidatePath('/retainers');
  revalidatePath('/documents');
  revalidatePath('/attention');
}
