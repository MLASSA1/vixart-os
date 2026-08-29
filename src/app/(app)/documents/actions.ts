'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { document, documentLine } from '@/db/schema';
import { withUser } from '@/db/session';
import { toCentimes, toMillis } from '@/lib/money';
import { describeDbError } from '@/lib/db-errors';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

const DOC_ERRORS = {
  document_zero_vat_needs_reason:
    'A 0 % rate has to state the legal reason for the exemption — it is a claim on the document, not a checkbox.',
  document_number_matches_status: 'A draft has no number; an issued document must have one.',
  document_paid_only_invoice: 'Only an invoice can be marked paid.',
};

/**
 * Creates a draft. Copying from a deal brings its lines and discount across —
 * the figures the client already discussed, not a fresh guess.
 */
export async function createDocumentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const docType = String(formData.get('docType') ?? 'devis');
  const companyId = String(formData.get('companyId') ?? '');
  const dealId = String(formData.get('dealId') ?? '').trim() || null;
  const subject = String(formData.get('subject') ?? '').trim() || null;

  if (!['devis', 'facture', 'avoir'].includes(docType)) return { error: 'Unknown document type.' };
  if (!companyId) return { error: 'Pick a client.' };

  let newId: string;
  try {
    newId = await withUser(async (tx, user) => {
      // The client's withholding setting and the VAT rate in force are copied
      // onto the draft now, and frozen for good when it is issued.
      const setup = await tx.execute<{
        [k: string]: unknown;
        retenue: boolean;
        vat_bp: string;
        wh_bp: string;
      }>(sql`
        SELECT c.retenue_source AS retenue,
               coalesce((SELECT rate_bp FROM fiscal_rate
                          WHERE key='tva_standard' AND effective_from <= current_date
                          ORDER BY effective_from DESC LIMIT 1), 2000)::text AS vat_bp,
               coalesce((SELECT rate_bp FROM fiscal_rate
                          WHERE key='retenue_source_tva' AND effective_from <= current_date
                          ORDER BY effective_from DESC LIMIT 1), 0)::text AS wh_bp
          FROM company c WHERE c.id = ${companyId}
      `);
      const s = setup.rows[0];
      if (!s) throw new Error('That client no longer exists.');

      const [row] = await tx
        .insert(document)
        .values({
          docType,
          companyId,
          dealId,
          subject,
          vatRateBp: Number(s.vat_bp),
          withholding: s.retenue,
          withholdingRateBp: Number(s.wh_bp),
          createdById: user.id,
        })
        .returning({ id: document.id });
      if (!row) throw new Error('The document could not be created.');

      if (dealId) {
        // Copy the deal's lines and discount. Snapshots of snapshots: the deal
        // already froze the price, and this freezes it again onto the document.
        await tx.execute(sql`
          INSERT INTO document_line
            (document_id, service_id, label, unit, unit_price_centimes, quantity_millis, position)
          SELECT ${row.id}, service_id, label, unit, unit_price_centimes, quantity_millis, position
            FROM deal_line WHERE deal_id = ${dealId} ORDER BY position
        `);
        await tx.execute(sql`
          UPDATE document SET discount_centimes =
            (SELECT discount_centimes FROM deal WHERE id = ${dealId})
          WHERE id = ${row.id}
        `);
      }
      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error, DOC_ERRORS) };
  }

  revalidatePath('/documents');
  redirect(`/documents/${newId}`);
}

export async function addDocumentLineAction(
  documentId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const serviceId = String(formData.get('serviceId') ?? '').trim();
  const freeLabel = String(formData.get('label') ?? '').trim();
  const rawQty = String(formData.get('quantity') ?? '1').trim();

  let quantityMillis: bigint;
  try {
    quantityMillis = toMillis(rawQty === '' ? '1' : rawQty);
  } catch {
    return { error: 'The quantity could not be read. Use a figure like 1, 2 or 1,5.' };
  }
  if (quantityMillis <= 0n) return { error: 'The quantity must be greater than zero.' };

  try {
    await withUser(async (tx) => {
      const next = await tx.execute<{ [k: string]: unknown; n: string }>(
        sql`SELECT coalesce(max(position) + 1, 0)::text AS n FROM document_line WHERE document_id = ${documentId}`,
      );
      const position = Number(next.rows[0]?.n ?? 0);

      if (serviceId) {
        const found = await tx.execute<{
          [k: string]: unknown; name: string; unit: string; price: string;
        }>(sql`
          SELECT s.name, s.unit,
                 coalesce((SELECT p.unit_price_centimes FROM service_price p
                            WHERE p.service_id = s.id AND p.effective_from <= current_date
                            ORDER BY p.effective_from DESC LIMIT 1), 0)::text AS price
            FROM service s WHERE s.id = ${serviceId}
        `);
        const svc = found.rows[0];
        if (!svc) throw new Error('That service no longer exists.');
        await tx.insert(documentLine).values({
          documentId,
          serviceId,
          label: svc.name,
          unit: svc.unit,
          unitPriceCentimes: BigInt(svc.price),
          quantityMillis,
          position,
        });
      } else {
        // A free line, for something not in the catalog.
        if (!freeLabel) throw new Error('Pick a service, or type a description for a free line.');
        let price = 0n;
        try {
          const raw = String(formData.get('price') ?? '0').trim();
          price = raw === '' ? 0n : toCentimes(raw);
        } catch {
          throw new Error('The price could not be read.');
        }
        await tx.insert(documentLine).values({
          documentId,
          label: freeLabel,
          unit: 'forfait',
          unitPriceCentimes: price,
          quantityMillis,
          position,
        });
      }
    });
  } catch (error) {
    return { error: describeDbError(error, DOC_ERRORS) };
  }

  revalidatePath(`/documents/${documentId}`);
  return EMPTY_STATE;
}

export async function removeDocumentLineAction(formData: FormData): Promise<void> {
  const lineId = String(formData.get('lineId') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  if (!lineId) return;
  await withUser(async (tx) => {
    await tx.delete(documentLine).where(eq(documentLine.id, lineId));
  });
  revalidatePath(`/documents/${documentId}`);
}

/** Draft-only settings: discount, VAT rate, dates, terms. */
export async function updateDraftAction(
  documentId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let discount = 0n;
  try {
    const raw = String(formData.get('discount') ?? '0').trim();
    discount = raw === '' ? 0n : toCentimes(raw);
  } catch {
    return { error: 'The discount could not be read.' };
  }
  if (discount < 0n) return { error: 'A discount cannot be negative.' };

  const vatRateBp = Number(formData.get('vatRateBp') ?? 2000);
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10000) {
    return { error: 'The VAT rate must be between 0 and 100 %.' };
  }
  const reason = String(formData.get('vatExemptionReason') ?? '').trim() || null;
  if (vatRateBp === 0 && !reason) {
    return {
      error:
        'A 0 % rate has to state the legal reason for the exemption — it is a claim on the document.',
    };
  }

  try {
    await withUser(async (tx) => {
      await tx
        .update(document)
        .set({
          discountCentimes: discount,
          vatRateBp,
          vatExemptionReason: reason,
          subject: String(formData.get('subject') ?? '').trim() || null,
          notes: String(formData.get('notes') ?? '').trim() || null,
          paymentTerms: String(formData.get('paymentTerms') ?? '').trim() || null,
          dueDate: String(formData.get('dueDate') ?? '').trim() || null,
        })
        .where(eq(document.id, documentId));
    });
  } catch (error) {
    return { error: describeDbError(error, DOC_ERRORS) };
  }

  revalidatePath(`/documents/${documentId}`);
  return EMPTY_STATE;
}

/**
 * Issue. Everything happens inside app.issue_document: the number is taken
 * under a row lock, the totals are computed and the client's identity is
 * frozen, all in one transaction. From here the document is read-only.
 */
export async function issueDocumentAction(formData: FormData): Promise<void> {
  const id = String(formData.get('documentId') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '').trim();
  // Issuing is irreversible — a wrong one can only be corrected by a credit
  // note — so it takes a typed confirmation rather than a single click.
  if (!id || confirmation !== 'ISSUE') return;

  await withUser(async (tx) => {
    await tx.execute(sql`SELECT app.issue_document(${id})`);
  });

  revalidatePath('/documents');
  revalidatePath(`/documents/${id}`);
  revalidatePath('/dashboard');
}

export async function setDocumentStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('documentId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!id || !['paye', 'annule'].includes(status)) return;

  await withUser(async (tx) => {
    await tx
      .update(document)
      .set({
        status,
        paidAt: status === 'paye' ? new Date() : null,
        cancelledAt: status === 'annule' ? new Date() : null,
      })
      .where(eq(document.id, id));
  });

  revalidatePath('/documents');
  revalidatePath(`/documents/${id}`);
  revalidatePath('/dashboard');
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const id = String(formData.get('documentId') ?? '');
  if (!id) return;
  // Only a draft can be deleted; the trigger refuses anything issued.
  await withUser(async (tx) => {
    await tx.delete(document).where(eq(document.id, id));
  });
  revalidatePath('/documents');
  redirect('/documents');
}

/**
 * Build a complete document in one go — header, client identity, every line —
 * and optionally issue it in the same breath.
 *
 * The older flow created an empty draft and then took one round trip per line.
 * That is fine when you are correcting something, and tedious when you are
 * writing a quote from scratch in front of a client. This does the whole thing
 * in ONE transaction, which also means a half-written document can never reach
 * the database: either the header and all its lines land, or nothing does.
 *
 * The client's identity is copied onto the document rather than referenced.
 * An invoice has to keep saying what it said on the day it was issued, even
 * after the client changes their address or their ICE is corrected.
 */
export async function buildDocumentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const docType = String(formData.get('docType') ?? 'devis');
  const companyId = String(formData.get('companyId') ?? '');
  const issueDate = String(formData.get('issueDate') ?? '').trim();
  const dueDate = String(formData.get('dueDate') ?? '').trim();
  const subject = String(formData.get('subject') ?? '').trim() || null;
  const notes = String(formData.get('notes') ?? '').trim() || null;
  const paymentTerms = String(formData.get('paymentTerms') ?? '').trim() || null;
  const vatReason = String(formData.get('vatExemptionReason') ?? '').trim() || null;
  const issueNow = String(formData.get('issueNow') ?? '') === 'yes';

  if (!['devis', 'facture'].includes(docType)) return { error: 'Unknown document type.' };
  if (!companyId) return { error: 'Pick a client.' };

  // The lines arrive as parallel arrays, which is what a plain HTML form can
  // express without JavaScript deciding the shape of the data.
  const labels = formData.getAll('lineLabel').map((v) => String(v).trim());
  const serviceIds = formData.getAll('lineServiceId').map((v) => String(v).trim());
  const units = formData.getAll('lineUnit').map((v) => String(v).trim());
  const prices = formData.getAll('linePrice').map((v) => String(v).trim());
  const quantities = formData.getAll('lineQuantity').map((v) => String(v).trim());

  const rows: Array<{
    label: string; serviceId: string | null; unit: string;
    price: bigint; quantity: bigint;
  }> = [];

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i] ?? '';
    // A blank row is a row the user added and did not fill. Skipping it is
    // kinder than refusing the whole form over it.
    if (!label) continue;
    try {
      const quantity = toMillis(quantities[i] || '1');
      if (quantity <= 0n) return { error: `"${label}" needs a quantity above zero.` };
      rows.push({
        label,
        serviceId: serviceIds[i] || null,
        unit: units[i] || 'forfait',
        price: toCentimes(prices[i] || '0'),
        quantity,
      });
    } catch {
      return { error: `Check the price and quantity on "${label}".` };
    }
  }

  if (rows.length === 0) return { error: 'A document needs at least one line.' };

  let discount: bigint;
  try {
    discount = toCentimes(String(formData.get('discount') ?? '0').trim() || '0');
  } catch {
    return { error: 'The discount has to be an amount in dirhams.' };
  }
  if (discount < 0n) return { error: 'A discount cannot be negative.' };

  let newId: string;
  try {
    newId = await withUser(async (tx, user) => {
      const setup = await tx.execute<{
        [k: string]: unknown;
        retenue: boolean; vat_bp: string; wh_bp: string;
        name: string; legal_name: string | null; ice: string | null;
        tax_id: string | null; address: string | null;
      }>(sql`
        SELECT c.retenue_source AS retenue, c.name, c.legal_name, c.ice,
               c.identifiant_fiscal AS tax_id,
               -- Street and city are two columns here and one line on paper.
               nullif(concat_ws(', ', nullif(c.address_line,''), nullif(c.city,'')), '') AS address,
               coalesce((SELECT rate_bp FROM fiscal_rate
                          WHERE key='tva_standard' AND effective_from <= current_date
                          ORDER BY effective_from DESC LIMIT 1), 2000)::text AS vat_bp,
               coalesce((SELECT rate_bp FROM fiscal_rate
                          WHERE key='retenue_source_tva' AND effective_from <= current_date
                          ORDER BY effective_from DESC LIMIT 1), 0)::text AS wh_bp
          FROM company c WHERE c.id = ${companyId}
      `);
      const s = setup.rows[0];
      if (!s) throw new Error('That client no longer exists.');

      // An explicit rate on the form wins over the one in force, so a document
      // can be exempt without changing the rate for everyone else.
      const formVat = String(formData.get('vatRateBp') ?? '').trim();
      const vatRateBp = formVat === '' ? Number(s.vat_bp) : Number(formVat);
      if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) {
        throw new Error('That VAT rate is not a rate.');
      }

      const [row] = await tx
        .insert(document)
        .values({
          docType,
          companyId,
          subject,
          notes,
          paymentTerms,
          issueDate: issueDate || undefined,
          dueDate: dueDate || null,
          vatRateBp,
          vatExemptionReason: vatRateBp === 0 ? vatReason : null,
          withholding: s.retenue,
          withholdingRateBp: Number(s.wh_bp),
          discountCentimes: discount,
          // Frozen now, so the document keeps saying what it said today.
          clientName: s.name,
          clientLegalName: s.legal_name,
          clientIce: s.ice,
          clientIf: s.tax_id,
          clientAddress: s.address,
          createdById: user.id,
        })
        .returning({ id: document.id });
      if (!row) throw new Error('The document could not be created.');

      await tx.insert(documentLine).values(
        rows.map((r, position) => ({
          documentId: row.id,
          serviceId: r.serviceId,
          label: r.label,
          unit: r.unit,
          unitPriceCentimes: r.price,
          quantityMillis: r.quantity,
          position,
        })),
      );

      // Issuing inside the same transaction: the number is assigned, the
      // figures are computed and frozen, and the whole thing is immutable from
      // that point. If anything above failed, no number was consumed.
      if (issueNow) {
        await tx.execute(sql`SELECT app.issue_document(${row.id})`);
      }

      return row.id;
    });
  } catch (error) {
    return { error: describeDbError(error, DOC_ERRORS) };
  }

  revalidatePath('/documents');
  revalidatePath('/dashboard');
  redirect(`/documents/${newId}`);
}
