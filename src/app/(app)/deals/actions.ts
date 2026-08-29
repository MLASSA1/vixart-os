'use server';

import { and, eq, notInArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { deal, dealLine } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes, toMillis } from '@/lib/money';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { describeDbError } from '@/lib/db-errors';

const DEAL_ERRORS = {
  deal_lost_needs_reason:
    'A lost deal has to say why it was lost — that is the whole point of recording it.',
};

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const dealSchema = z.object({
  companyId: z.string().uuid('Pick an organisation.'),
  title: z.string().trim().min(1, 'A title is required.'),
  description: optionalText,
  stage: z.enum(['new_lead','contacted','meeting_booked','proposal','negotiation','won','lost']),
  probability: z.coerce.number().int().min(0).max(100),
  expectedCloseDate: optionalText,
  lostReason: optionalText,
});


export async function saveDealAction(
  dealId: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = dealSchema.safeParse({
    companyId: formData.get('companyId') ?? '',
    title: formData.get('title') ?? '',
    description: formData.get('description') ?? '',
    stage: formData.get('stage') ?? 'proposal',
    probability: formData.get('probability') ?? 50,
    expectedCloseDate: formData.get('expectedCloseDate') ?? '',
    lostReason: formData.get('lostReason') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  // Value is typed as text and parsed to centimes. It never becomes a float.
  let valueCentimes: bigint;
  try {
    const raw = String(formData.get('value') ?? '').trim();
    valueCentimes = raw === '' ? 0n : toCentimes(raw);
  } catch {
    return { error: 'The value could not be read. Use a figure like 12 000 or 12000,50.' };
  }
  if (valueCentimes < 0n) return { error: 'The value cannot be negative.' };

  const closed = parsed.data.stage === 'won' || parsed.data.stage === 'lost';
  const values = {
    ...parsed.data,
    valueCentimes,
    closedAt: closed ? new Date() : null,
    lostReason: parsed.data.stage === 'lost' ? parsed.data.lostReason : null,
  };

  try {
    await withUser(async (tx, user) => {
      if (dealId) {
        await tx.update(deal).set(values).where(eq(deal.id, dealId));
      } else {
        await tx.insert(deal).values({ ...values, ownerId: user.id });
      }
    });
  } catch (error) {
    return { error: describeDbError(error, DEAL_ERRORS) };
  }

  revalidatePath('/deals');
  revalidatePath('/');
  return EMPTY_STATE;
}

export async function setDealStageAction(formData: FormData): Promise<void> {
  const id = String(formData.get('dealId') ?? '');
  const stage = String(formData.get('stage') ?? '');
  const allowed = ['new_lead','contacted','meeting_booked','proposal','negotiation','won','lost'] as const;
  if (!id || !allowed.includes(stage as (typeof allowed)[number])) return;
  // 'lost' needs a reason, so it is only ever set from the full form.
  if (stage === 'lost') return;

  await withUser(async (tx) => {
    await tx
      .update(deal)
      .set({
        stage: stage as (typeof allowed)[number],
        closedAt: stage === 'won' ? new Date() : null,
      })
      // A closed deal cannot be moved by a quick button, on the server as
      // well as in the UI — reopening clears closed_at and silently rewrites
      // the won totals, so it only happens through the full form.
      .where(and(eq(deal.id, id), notInArray(deal.stage, ['won', 'lost'])));
  });

  revalidatePath('/deals');
  revalidatePath('/');
}

export async function deleteDealAction(formData: FormData): Promise<void> {
  const id = String(formData.get('dealId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx.delete(deal).where(eq(deal.id, id));
  });
  revalidatePath('/deals');
}

// ---------------------------------------------------------------------------
// Deal lines — services picked onto the deal
// ---------------------------------------------------------------------------

/**
 * Adds a service to a deal, snapshotting its current price.
 *
 * The price is read at this moment and copied onto the line. Changing the
 * catalog later never moves this figure — that is the whole point of the
 * snapshot, and it is what keeps an already-sent quote honest.
 */
export async function addDealLineAction(
  dealId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const serviceId = String(formData.get('serviceId') ?? '').trim();
  const rawQty = String(formData.get('quantity') ?? '1').trim();

  let quantityMillis: bigint;
  try {
    quantityMillis = toMillis(rawQty === '' ? '1' : rawQty);
  } catch {
    return { error: 'The quantity could not be read. Use a figure like 1, 2 or 1,5.' };
  }
  if (quantityMillis <= 0n) return { error: 'The quantity must be greater than zero.' };

  if (!serviceId) return { error: 'Pick a service.' };

  try {
    await withUser(async (tx) => {
      // Current price = newest version already in force today.
      const found = await tx.execute<{
        [k: string]: unknown;
        name: string;
        unit: string;
        price: string;
      }>(sql`
        SELECT s.name, s.unit,
               coalesce((SELECT p.unit_price_centimes FROM service_price p
                          WHERE p.service_id = s.id AND p.effective_from <= current_date
                          ORDER BY p.effective_from DESC LIMIT 1), 0)::text AS price
          FROM service s WHERE s.id = ${serviceId}
      `);
      const svc = found.rows[0];
      if (!svc) throw new Error('That service no longer exists.');

      const next = await tx.execute<{ [k: string]: unknown; n: string }>(
        sql`SELECT coalesce(max(position) + 1, 0)::text AS n FROM deal_line WHERE deal_id = ${dealId}`,
      );

      await tx.insert(dealLine).values({
        dealId,
        serviceId,
        label: svc.name,
        unit: svc.unit,
        unitPriceCentimes: BigInt(svc.price),
        quantityMillis,
        position: Number(next.rows[0]?.n ?? 0),
      });
    });
  } catch (error) {
    return { error: describeDbError(error, DEAL_ERRORS) };
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  return EMPTY_STATE;
}

export async function removeDealLineAction(formData: FormData): Promise<void> {
  const lineId = String(formData.get('lineId') ?? '');
  const dealId = String(formData.get('dealId') ?? '');
  if (!lineId) return;
  await withUser(async (tx) => {
    await tx.delete(dealLine).where(eq(dealLine.id, lineId));
  });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
}

/** The discount is a money amount off the total, before VAT. */
export async function setDiscountAction(
  dealId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let discount: bigint;
  try {
    const raw = String(formData.get('discount') ?? '0').trim();
    discount = raw === '' ? 0n : toCentimes(raw);
  } catch {
    return { error: 'The discount could not be read. Use a figure like 5 000 or 5000,50.' };
  }
  if (discount < 0n) return { error: 'A discount cannot be negative.' };

  try {
    await withUser(async (tx) => {
      await tx.update(deal).set({ discountCentimes: discount }).where(eq(deal.id, dealId));
    });
  } catch (error) {
    return { error: describeDbError(error, DEAL_ERRORS) };
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath('/deals');
  return EMPTY_STATE;
}
