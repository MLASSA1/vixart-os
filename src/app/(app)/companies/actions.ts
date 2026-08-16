'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { company, contact, interaction } from '@/db/schema';
import { withUser } from '@/db/session';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Every write goes through `withUser`, so it runs inside a transaction that
 * carries the signed-in identity. The RLS policies are what actually enforce
 * who may do what; the checks here only produce readable messages.
 *
 * Validation is doubled on purpose: zod for the message, CHECK constraints and
 * policies in PostgreSQL for the guarantee.
 */


/** Trims, then turns an empty string into null — never store `''`. */
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable();

const iceSchema = optionalText.refine((v) => v === null || /^\d{15}$/.test(v), {
  message: 'The ICE must be exactly 15 digits.',
});

const taxIdSchema = optionalText.refine((v) => v === null || /^\d{6,9}$/.test(v), {
  message: 'The tax ID (IF) must be 6 to 9 digits.',
});

const clientSchema = z.object({
  name: z.string().trim().min(1, 'The name is required.'),
  legalName: optionalText,
  status: z.enum(['lead', 'prospect', 'client', 'dormant']),
  ice: iceSchema,
  identifiantFiscal: taxIdSchema,
  registreCommerce: optionalText,
  addressLine: optionalText,
  city: optionalText,
  website: optionalText,
  retenueSource: z.boolean(),
  engagementSummary: optionalText,
  notes: optionalText,
});

function readCompanyForm(formData: FormData) {
  return clientSchema.safeParse({
    name: formData.get('name') ?? '',
    legalName: formData.get('legalName') ?? '',
    status: formData.get('status') ?? 'lead',
    ice: formData.get('ice') ?? '',
    identifiantFiscal: formData.get('identifiantFiscal') ?? '',
    registreCommerce: formData.get('registreCommerce') ?? '',
    addressLine: formData.get('addressLine') ?? '',
    city: formData.get('city') ?? '',
    website: formData.get('website') ?? '',
    retenueSource: formData.get('retenueSource') === 'on',
    engagementSummary: formData.get('engagementSummary') ?? '',
    notes: formData.get('notes') ?? '',
  });
}


// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function createCompanyAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = readCompanyForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  let newId: string;
  try {
    newId = await withUser(async (tx) => {
      const [row] = await tx.insert(company).values(parsed.data).returning({ id: company.id });
      if (!row) throw new Error('Record could not be created.');
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath('/companies');
  redirect(`/companies/${newId}`);
}

export async function updateCompanyAction(
  companyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = readCompanyForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  try {
    await withUser(async (tx) => {
      await tx.update(company).set(parsed.data).where(eq(company.id, companyId));
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath('/companies');
  revalidatePath(`/companies/${companyId}`);
  redirect(`/companies/${companyId}`);
}

/**
 * Deleting a client cascades to its contacts and its whole timeline.
 * Reserved to management by the `client_delete_admin` policy — a member's
 * attempt simply deletes nothing.
 */
export async function deleteCompanyAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get('companyId') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '').trim();
  const expected = String(formData.get('expected') ?? '').trim();

  if (!companyId || confirmation !== expected || expected === '') return;

  await withUser(async (tx) => {
    await tx.delete(company).where(eq(company.id, companyId));
  });

  revalidatePath('/companies');
  redirect('/companies');
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const contactSchema = z.object({
  fullName: z.string().trim().min(1, 'The name is required.'),
  roleTitle: optionalText,
  email: optionalText,
  phone: optionalText,
  whatsapp: optionalText,
  isPrimary: z.boolean(),
  notes: optionalText,
});

function readContactForm(formData: FormData) {
  return contactSchema.safeParse({
    fullName: formData.get('fullName') ?? '',
    roleTitle: formData.get('roleTitle') ?? '',
    email: formData.get('email') ?? '',
    phone: formData.get('phone') ?? '',
    whatsapp: formData.get('whatsapp') ?? '',
    isPrimary: formData.get('isPrimary') === 'on',
    notes: formData.get('notes') ?? '',
  });
}

export async function createContactAction(
  companyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = readContactForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  try {
    await withUser(async (tx) => {
      // Only one primary contact per client: demote the previous one rather
      // than letting the partial unique index reject the insert.
      if (parsed.data.isPrimary) {
        await tx
          .update(contact)
          .set({ isPrimary: false })
          .where(and(eq(contact.companyId, companyId), eq(contact.isPrimary, true)));
      }
      await tx.insert(contact).values({ ...parsed.data, companyId });
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath(`/companies/${companyId}`);
  return EMPTY_STATE;
}

export async function updateContactAction(
  companyId: string,
  contactId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = readContactForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  try {
    await withUser(async (tx) => {
      if (parsed.data.isPrimary) {
        await tx
          .update(contact)
          .set({ isPrimary: false })
          .where(and(eq(contact.companyId, companyId), eq(contact.isPrimary, true)));
      }
      await tx.update(contact).set(parsed.data).where(eq(contact.id, contactId));
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath(`/companies/${companyId}`);
  return EMPTY_STATE;
}

export async function deleteContactAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get('companyId') ?? '');
  const contactId = String(formData.get('contactId') ?? '');
  if (!companyId || !contactId) return;

  await withUser(async (tx) => {
    await tx.delete(contact).where(eq(contact.id, contactId));
  });

  revalidatePath(`/companies/${companyId}`);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const interactionSchema = z.object({
  kind: z.enum(['note', 'reunion', 'appel', 'whatsapp', 'email', 'proposition']),
  title: z.string().trim().min(1, 'A subject is required.'),
  body: optionalText,
  occurredAt: z.string().trim().min(1, 'A date is required.'),
});

export async function createInteractionAction(
  companyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = interactionSchema.safeParse({
    kind: formData.get('kind') ?? 'note',
    title: formData.get('title') ?? '',
    body: formData.get('body') ?? '',
    occurredAt: formData.get('occurredAt') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid form.' };
  }

  // `datetime-local` sends wall-clock time with no offset. The field is filled
  // and read in Casablanca time, so it is interpreted there too.
  const occurredAt = new Date(`${parsed.data.occurredAt}:00+01:00`);
  if (Number.isNaN(occurredAt.getTime())) {
    return { error: 'That date could not be read.' };
  }

  try {
    await withUser(async (tx, user) => {
      await tx.insert(interaction).values({
        companyId,
        // Enforced again by the RLS policy: an entry is always signed by its
        // author, never by a colleague.
        authorId: user.id,
        authorName: user.name,
        kind: parsed.data.kind,
        title: parsed.data.title,
        body: parsed.data.body,
        occurredAt,
      });
    });
  } catch (error) {
    return { error: describeDbError(error) };
  }

  revalidatePath(`/companies/${companyId}`);
  return EMPTY_STATE;
}

export async function deleteInteractionAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get('companyId') ?? '');
  const interactionId = String(formData.get('interactionId') ?? '');
  if (!companyId || !interactionId) return;

  // A member can only delete their own entries; management can delete any.
  // The `interaction_delete` policy decides, not this code.
  await withUser(async (tx) => {
    await tx.delete(interaction).where(eq(interaction.id, interactionId));
  });

  revalidatePath(`/companies/${companyId}`);
}

// ---------------------------------------------------------------------------
// Pipeline status — one click from the client record
// ---------------------------------------------------------------------------

export async function setStatusAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get('companyId') ?? '');
  const status = String(formData.get('status') ?? '');
  const allowed = ['lead', 'prospect', 'client', 'dormant'] as const;
  if (!companyId || !allowed.includes(status as (typeof allowed)[number])) return;

  await withUser(async (tx) => {
    await tx
      .update(company)
      .set({ status: status as (typeof allowed)[number] })
      .where(eq(company.id, companyId));
  });

  revalidatePath('/companies');
  revalidatePath(`/companies/${companyId}`);
}

