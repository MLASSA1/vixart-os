'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { equipment } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes } from '@/lib/money';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const EQUIPMENT_ERRORS = {
  equipment_serial_key: 'A piece of kit with that serial number is already registered.',
  equipment_assignment_coherent:
    'Checked-out kit needs someone holding it. Pick a person, or set another status.',
  equipment_name_not_empty: 'Give it a name.',
};

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const schema = z.object({
  name: z.string().trim().min(1, 'Give it a name.'),
  category: z.enum([
    'camera', 'lens', 'audio', 'lighting', 'computer',
    'phone', 'drone', 'storage', 'accessory', 'autre',
  ]),
  brand: optionalText,
  model: optionalText,
  serialNumber: optionalText,
  notes: optionalText,
  purchaseDate: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});

export async function addEquipmentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = schema.safeParse({
    name: formData.get('name') ?? '',
    category: formData.get('category') ?? 'autre',
    brand: formData.get('brand') ?? '',
    model: formData.get('model') ?? '',
    serialNumber: formData.get('serialNumber') ?? '',
    notes: formData.get('notes') ?? '',
    purchaseDate: formData.get('purchaseDate') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  let cost = 0n;
  try {
    const raw = String(formData.get('purchaseCost') ?? '').trim();
    if (raw !== '') cost = toCentimes(raw);
  } catch {
    return { error: 'The purchase cost could not be read. Use a figure like 12 000.' };
  }

  try {
    await withUser(async (tx) => {
      await tx.insert(equipment).values({ ...parsed.data, purchaseCostCentimes: cost });
    });
  } catch (error) {
    return { error: describeDbError(error, EQUIPMENT_ERRORS) };
  }

  revalidatePath('/equipment');
  return EMPTY_STATE;
}

/**
 * Hands a piece of kit to someone, or takes it back.
 *
 * `assigned_at` is stamped by a trigger, and a CHECK keeps status and holder
 * consistent — so "checked out to nobody" cannot exist.
 */
export async function assignEquipmentAction(formData: FormData): Promise<void> {
  const id = String(formData.get('equipmentId') ?? '');
  const holder = String(formData.get('assignedToId') ?? '').trim();
  if (!id) return;

  await withUser(async (tx) => {
    await tx
      .update(equipment)
      .set(
        holder
          ? { status: 'assigned', assignedToId: holder }
          : { status: 'available', assignedToId: null },
      )
      .where(eq(equipment.id, id));
  });

  revalidatePath('/equipment');
}

export async function setEquipmentStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('equipmentId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!id || !['available', 'repair', 'retired', 'lost'].includes(status)) return;

  await withUser(async (tx) => {
    // Anything other than 'assigned' has no holder — the CHECK enforces it, so
    // the holder is cleared here rather than left to fail.
    await tx
      .update(equipment)
      .set({ status, assignedToId: null })
      .where(eq(equipment.id, id));
  });

  revalidatePath('/equipment');
}

export async function deleteEquipmentAction(formData: FormData): Promise<void> {
  const id = String(formData.get('equipmentId') ?? '');
  if (!id) return;
  await withUser(async (tx) => {
    await tx.delete(equipment).where(eq(equipment.id, id));
  });
  revalidatePath('/equipment');
}
