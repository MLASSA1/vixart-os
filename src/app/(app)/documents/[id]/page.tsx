import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, Field, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { Attachments } from '@/components/Attachments';
import { listAttachments, uploadAttachmentAction } from '@/lib/attachment-actions';
import { DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS, SERVICE_UNIT_LABELS } from '@/lib/labels';
import { formatMAD, fromCentimes, fromMillis } from '@/lib/money';
import { computeDealTotals } from '@/lib/deal-totals';
import { applyRate } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { AddLineForm, DraftSettingsForm } from './DraftForms';
import { Payments, type PaymentRow } from './Payments';
import {
  addDocumentLineAction,
  deleteDraftAction,
  deletePaymentAction,
  issueDocumentAction,
  recordPaymentAction,
  removeDocumentLineAction,
  setDocumentStatusAction,
  updateDraftAction,
} from '../actions';

export const dynamic = 'force-dynamic';

interface DocRow {
  [k: string]: unknown;
  id: string; doc_type: string; status: string; number: string | null;
  subject: string | null; notes: string | null; payment_terms: string | null;
  company_id: string; company_name: string; company_ice: string | null;
  company_if: string | null; company_address: string | null;
  client_name: string | null; client_ice: string | null; client_if: string | null;
  client_address: string | null;
  issue_date: string | null; due_date: string | null;
  vat_rate_bp: number; vat_exemption_reason: string | null;
  withholding: boolean; withholding_rate_bp: number;
  discount_centimes: string;
  total_excl_vat: string; total_vat: string; total_incl_vat: string;
  withheld: string; net_to_collect: string;
}

interface LineRow {
  [k: string]: unknown;
  id: string; label: string; unit: string;
  unit_price_centimes: string; quantity_millis: string;
}

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (session?.user.role !== 'admin') redirect('/dashboard');

  const data = await withUser(async (tx) => {
    const d = await tx.execute<DocRow>(sql`
      SELECT d.*, c.name AS company_name, c.ice AS company_ice,
             c.identifiant_fiscal AS company_if,
             concat_ws(', ', c.address_line, c.city) AS company_address,
             d.issue_date::text AS issue_date, d.due_date::text AS due_date,
             d.discount_centimes::text, d.total_excl_vat::text, d.total_vat::text,
             d.total_incl_vat::text, d.withheld::text, d.net_to_collect::text
        FROM document d JOIN company c ON c.id = d.company_id
       WHERE d.id = ${id}
    `);
    const record = d.rows[0];
    if (!record) return null;

    const lines = await tx.execute<LineRow>(sql`
      SELECT id, label, unit, unit_price_centimes::text, quantity_millis::text
        FROM document_line WHERE document_id = ${id} ORDER BY position, created_at
    `);
    const services = await tx.execute<{
      [k: string]: unknown; id: string; name: string; unit: string; price: string;
    }>(sql`
      SELECT s.id, s.name, s.unit,
             coalesce((SELECT p.unit_price_centimes FROM service_price p
                        WHERE p.service_id = s.id AND p.effective_from <= current_date
                        ORDER BY p.effective_from DESC LIMIT 1), 0)::text AS price
        FROM service s WHERE s.is_active ORDER BY s.pillar, lower(s.name)
    `);
    const payments = await tx.execute<{
      [k: string]: unknown;
      id: string; amount: string; method: string; paid_on: string; note: string | null;
    }>(sql`
      SELECT id, amount_centimes::text AS amount, method, paid_on::text, note
        FROM document_payment WHERE document_id = ${id}
       ORDER BY paid_on, created_at
    `);

    return { record, lines: lines.rows, services: services.rows, payments: payments.rows };
  });

  const files = await listAttachments('document', id);

  if (!data) notFound();
  const { record, lines, services, payments } = data;
  const isDraft = record.status === 'brouillon';

  // A draft recomputes live; an issued document shows the frozen figures.
  const live = computeDealTotals({
    lines: lines.map((l) => ({
      unitPriceCentimes: BigInt(l.unit_price_centimes),
      quantityMillis: BigInt(l.quantity_millis),
    })),
    discountCentimes: BigInt(record.discount_centimes),
    vatRateBp: record.vat_rate_bp,
  });

  const totals = isDraft
    ? {
        excl: live.totalExclVat,
        vat: live.totalVat,
        incl: live.totalInclVat,
        withheld: record.withholding
          ? applyRate(live.totalVat, record.withholding_rate_bp)
          : 0n,
        discount: live.discountApplied,
        subtotal: live.subtotal,
      }
    : {
        excl: BigInt(record.total_excl_vat),
        vat: BigInt(record.total_vat),
        incl: BigInt(record.total_incl_vat),
        withheld: BigInt(record.withheld),
        discount: BigInt(record.discount_centimes),
        subtotal: BigInt(record.total_excl_vat) + BigInt(record.discount_centimes),
      };
  const net = totals.incl - totals.withheld;

  return (
    <>
      <PageHeader
        eyebrow={`${DOCUMENT_TYPE_LABELS[record.doc_type]} · ${DOCUMENT_STATUS_LABELS[record.status]}`}
        title={record.number ?? 'Draft'}
        actions={
          <>
            {!isDraft && (
              <a href={`/documents/${record.id}/pdf`} className="btn" target="_blank" rel="noreferrer">
                Download PDF
              </a>
            )}
            <Link href="/documents" className="btn btn-inverse">
              Back
            </Link>
          </>
        }
      />

      {isDraft && (
        <p className="prose-vixart mb-6 border-2 border-void px-4 py-3">
          <strong>This is a draft.</strong> It has no number and can be changed
          freely. Issuing it takes the next number in the run and makes it
          permanently read-only — a mistake after that can only be corrected by a
          credit note.
        </p>
      )}

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <Field
            label="Client"
            value={
              <Link href={`/companies/${record.company_id}`} className="underline underline-offset-4">
                {record.client_name ?? record.company_name}
              </Link>
            }
          />
          <Field label="ICE" value={record.client_ice ?? record.company_ice} />
          <Field label="Tax ID" value={record.client_if ?? record.company_if} />
          <Field label="Address" value={record.client_address ?? record.company_address} />
        </div>
        <div>
          <Field label="Issued" value={record.issue_date ? formatDate(record.issue_date) : null} />
          <Field label="Due" value={record.due_date ? formatDate(record.due_date) : null} />
          <Field label="VAT rate" value={`${record.vat_rate_bp / 100} %`} />
          {record.vat_exemption_reason && (
            <Field label="Exemption" value={record.vat_exemption_reason} />
          )}
        </div>
      </div>

      <Section title={`Lines — ${lines.length}`}>
        {lines.length === 0 ? (
          <Empty message="No line yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Description</th>
                  <th className="th py-2 pr-4 text-right">Unit price</th>
                  <th className="th py-2 pr-4 text-right">Qty</th>
                  <th className="th py-2 pr-4 text-right">Total</th>
                  {isDraft && <th className="th py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={line.id} className="border-b border-void/10">
                    <td className="py-2.5 pr-4">
                      <span className="font-medium">{line.label}</span>
                      <span className="hint ml-2">
                        {SERVICE_UNIT_LABELS[line.unit] ?? line.unit}
                      </span>
                    </td>
                    <td className="code py-2.5 pr-4 text-right whitespace-nowrap">
                      {formatMAD(BigInt(line.unit_price_centimes))}
                    </td>
                    <td className="code py-2.5 pr-4 text-right">
                      {fromMillis(BigInt(line.quantity_millis))}
                    </td>
                    <td className="code py-2.5 pr-4 text-right font-semibold whitespace-nowrap">
                      {formatMAD(live.lineTotals[i] ?? 0n)}
                    </td>
                    {isDraft && (
                      <td className="py-2.5 text-right">
                        <form action={removeDocumentLineAction}>
                          <input type="hidden" name="lineId" value={line.id} />
                          <input type="hidden" name="documentId" value={record.id} />
                          <button type="submit" className="hint cursor-pointer underline underline-offset-4">
                            Remove
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {isDraft && (
          <AddLineForm
            action={addDocumentLineAction.bind(null, record.id)}
            services={services.map((s) => ({
              id: s.id,
              name: s.name,
              unit_label: SERVICE_UNIT_LABELS[s.unit] ?? s.unit,
              price: formatMAD(BigInt(s.price)),
            }))}
          />
        )}
      </Section>

      <Section title="Total">
        <div className="max-w-md">
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Subtotal</span>
            <span className="code">{formatMAD(totals.subtotal)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Discount</span>
            <span className="code">
              {totals.discount > 0n ? `− ${formatMAD(totals.discount)}` : '—'}
            </span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Total excl. VAT</span>
            <span className="code font-semibold">{formatMAD(totals.excl)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">VAT {record.vat_rate_bp / 100} %</span>
            <span className="code">{formatMAD(totals.vat)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b-2 border-void py-2.5">
            <span className="font-semibold">Total incl. VAT</span>
            <span className="code text-lg font-bold">{formatMAD(totals.incl)}</span>
          </div>
          {record.withholding && (
            <>
              <div className="flex items-baseline justify-between border-b border-void/10 py-2">
                <span className="label">
                  Withheld at source {record.withholding_rate_bp / 100} %
                </span>
                <span className="code">− {formatMAD(totals.withheld)}</span>
              </div>
              <div className="flex items-baseline justify-between border-b-2 border-void py-2.5">
                <span className="font-semibold">Net to collect</span>
                <span className="code text-lg font-bold">{formatMAD(net)}</span>
              </div>
              {record.withholding_rate_bp === 0 && (
                <p className="hint mt-2">
                  This client withholds at source, but the rate is still 0. Set it in
                  System before issuing, or the net will equal the total.
                </p>
              )}
            </>
          )}
        </div>
      </Section>

      {/* Money received. Only an issued invoice can take money; the advance
          is the first payment, whatever amount was agreed. */}
      {record.doc_type === 'facture' && !isDraft && record.status !== 'annule' && (
        <Section title="Payments">
          <Payments
            documentId={record.id}
            net={record.net_to_collect}
            settled={record.status === 'paye'}
            today={new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' })}
            payments={payments.map(
              (p): PaymentRow => ({
                id: String(p.id),
                amount: String(p.amount),
                method: String(p.method),
                paidOn: String(p.paid_on),
                note: (p.note as string) ?? null,
              }),
            )}
            record={recordPaymentAction.bind(null, record.id)}
            remove={deletePaymentAction}
          />
        </Section>
      )}

      {isDraft ? (
        <>
          <Section title="Draft settings">
            <DraftSettingsForm
              action={updateDraftAction.bind(null, record.id)}
              values={{
                discount:
                  record.discount_centimes === '0'
                    ? ''
                    : fromCentimes(BigInt(record.discount_centimes)).replace('.', ','),
                vatRateBp: record.vat_rate_bp,
                vatExemptionReason: record.vat_exemption_reason ?? '',
                subject: record.subject ?? '',
                notes: record.notes ?? '',
                paymentTerms: record.payment_terms ?? '',
                dueDate: record.due_date ?? '',
              }}
            />
          </Section>

          <Section title="Issue this document">
            <p className="prose-vixart" style={{ opacity: 0.7 }}>
              Issuing takes the next number in the {DOCUMENT_TYPE_LABELS[record.doc_type]}{' '}
              run for {new Date().getFullYear()}, freezes the client&apos;s details and
              every figure, and makes the document permanently read-only. There is no
              undo — a mistake is corrected by issuing a credit note.
            </p>
            <form action={issueDocumentAction} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="documentId" value={record.id} />
              <label className="block" htmlFor="confirmation">
                <span className="label block">Type ISSUE to confirm</span>
                <input
                  id="confirmation"
                  name="confirmation"
                  autoComplete="off"
                  className="input w-48"
                />
              </label>
              <button type="submit" className="btn" disabled={lines.length === 0}>
                Issue {DOCUMENT_TYPE_LABELS[record.doc_type]}
              </button>
            </form>
            {lines.length === 0 && (
              <p className="hint mt-2">Add at least one line before issuing.</p>
            )}

            <form action={deleteDraftAction} className="mt-8">
              <input type="hidden" name="documentId" value={record.id} />
              <button type="submit" className="btn btn-inverse btn-small">
                Delete this draft
              </button>
            </form>
          </Section>
        </>
      ) : (
        <Section title="Status">
          <p className="prose-vixart" style={{ opacity: 0.7 }}>
            {record.number} is issued and read-only. The database refuses any change
            to its figures — correcting it means issuing a credit note.
          </p>
          {record.status === 'emis' && record.doc_type === 'facture' && (
            <div className="mt-4 flex flex-wrap gap-3">
              {/* Once money is recorded, settling happens through payments —
                  a manual "paid" beside a half-paid invoice would lie to the
                  books. */}
              {payments.length === 0 && (
                <form action={setDocumentStatusAction}>
                  <input type="hidden" name="documentId" value={record.id} />
                  <input type="hidden" name="status" value="paye" />
                  <button type="submit" className="btn">
                    Mark paid
                  </button>
                </form>
              )}
              <form action={setDocumentStatusAction}>
                <input type="hidden" name="documentId" value={record.id} />
                <input type="hidden" name="status" value="annule" />
                <button type="submit" className="btn btn-inverse">
                  Cancel
                </button>
              </form>
            </div>
          )}
        </Section>
      )}
      {/* A signed quote or a proof of payment is evidence about the document,
          not part of it — attaching one never touches the issued figures. */}
      <Section title={`Attached files — ${files.length}`}>
        <Attachments
          action={uploadAttachmentAction.bind(null, 'document', record.id, `/documents/${record.id}`)}
          items={files.map((f) => ({
            id: f.id,
            originalName: f.originalName,
            mimeType: f.mimeType,
            sizeBytes: String(f.sizeBytes),
            caption: f.caption,
            uploaderName: null,
            createdAt: String(f.createdAt),
          }))}
          revalidate={`/documents/${record.id}`}
        />
      </Section>

    </>
  );
}
