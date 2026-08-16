'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { service, servicePrice } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes } from '@/lib/money';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';
import { describeDbError } from '@/lib/db-errors';

const SERVICE_ERRORS = {
  service_price_version_key:
    'A price already starts on that date. Pick a later start date — existing ' +
    'versions are never overwritten, so a quote issued under the old price keeps it.',
};

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();


const serviceSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  pillar: z.enum([
    'brand_architecture',
    'cinematic_production',
    'digital_presence',
    'social_media',
    'growth_marketing',
    'app_automation',
    'codex_ai',
  ]),
  unit: z.enum(['forfait', 'mois', 'jour']),
  description: optionalText,
});

/** Create a service. Its first price version starts today, at 0. */
export async function createServiceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = serviceSchema.safeParse({
    name: formData.get('name') ?? '',
    pillar: formData.get('pillar') ?? 'brand_architecture',
    unit: formData.get('unit') ?? 'forfait',
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  let priceCentimes = 0n;
  try {
    const raw = String(formData.get('price') ?? '').trim();
    if (raw !== '') priceCentimes = toCentimes(raw);
  } catch {
    return { error: 'The price could not be read. Use a figure like 12 000 or 12000,50.' };
  }

  try {
    await withUser(async (tx, user) => {
      const [row] = await tx.insert(service).values(parsed.data).returning({ id: service.id });
      if (!row) throw new Error('The service could not be created.');
      await tx.insert(servicePrice).values({
        serviceId: row.id,
        unitPriceCentimes: priceCentimes,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        createdById: user.id,
      });
    });
  } catch (error) {
    return { error: describeDbError(error, SERVICE_ERRORS) };
  }

  revalidatePath('/services');
  return EMPTY_STATE;
}

export async function updateServiceAction(
  serviceId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = serviceSchema.safeParse({
    name: formData.get('name') ?? '',
    pillar: formData.get('pillar') ?? 'brand_architecture',
    unit: formData.get('unit') ?? 'forfait',
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }
  try {
    await withUser(async (tx) => {
      await tx.update(service).set(parsed.data).where(eq(service.id, serviceId));
    });
  } catch (error) {
    return { error: describeDbError(error, SERVICE_ERRORS) };
  }
  revalidatePath('/services');
  return EMPTY_STATE;
}

/**
 * Set a new price. This never edits the current one — it appends a version.
 * The old figure stays readable, and any document issued under it is unchanged.
 */
export async function setPriceAction(
  serviceId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return { error: 'Pick the date this price starts applying.' };
  }

  let priceCentimes: bigint;
  try {
    priceCentimes = toCentimes(String(formData.get('price') ?? '0'));
  } catch {
    return { error: 'The price could not be read. Use a figure like 12 000 or 12000,50.' };
  }
  if (priceCentimes < 0n) return { error: 'A price cannot be negative.' };

  try {
    await withUser(async (tx, user) => {
      await tx.insert(servicePrice).values({
        serviceId,
        unitPriceCentimes: priceCentimes,
        effectiveFrom,
        note: String(formData.get('note') ?? '').trim() || null,
        createdById: user.id,
      });
    });
  } catch (error) {
    return { error: describeDbError(error, SERVICE_ERRORS) };
  }

  revalidatePath('/services');
  return EMPTY_STATE;
}

export async function toggleServiceAction(formData: FormData): Promise<void> {
  const id = String(formData.get('serviceId') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';
  if (!id) return;
  await withUser(async (tx) => {
    await tx.update(service).set({ isActive: active }).where(eq(service.id, id));
  });
  revalidatePath('/services');
}
