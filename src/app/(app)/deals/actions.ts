'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { deal } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes } from '@/lib/money';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const dealSchema = z.object({
  companyId: z.string().uuid('Pick an organisation.'),
  title: z.string().trim().min(1, 'A title is required.'),
  description: optionalText,
  stage: z.enum(['proposal', 'negotiation', 'won', 'lost']),
  probability: z.coerce.number().int().min(0).max(100),
  expectedCloseDate: optionalText,
  lostReason: optionalText,
});

function readable(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  if (m.includes('deal_lost_needs_reason')) {
    return 'A lost deal has to say why it was lost — that is the whole point of recording it.';
  }
  if (m.includes('deal_value_non_negative')) return 'The value cannot be negative.';
  if (m.includes('row-level security')) {
    return 'Deals carry money, so they are limited to management and the work moderator.';
  }
  return m;
}

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
    return { error: readable(error) };
  }

  revalidatePath('/deals');
  revalidatePath('/');
  return EMPTY_STATE;
}

export async function setDealStageAction(formData: FormData): Promise<void> {
  const id = String(formData.get('dealId') ?? '');
  const stage = String(formData.get('stage') ?? '');
  const allowed = ['proposal', 'negotiation', 'won', 'lost'] as const;
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
      .where(eq(deal.id, id));
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
