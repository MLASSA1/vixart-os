import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, Field, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { DEAL_STAGE_LABELS, SERVICE_UNIT_LABELS } from '@/lib/labels';
import { formatMAD, fromCentimes, fromMillis, lineTotal, sum } from '@/lib/money';
import { computeTotals } from '@/lib/fiscal';
import { formatDate } from '@/lib/format';
import { addDealLineAction, removeDealLineAction, setDiscountAction } from '../actions';
import { AddLineForm, DiscountForm } from './LineForms';

export const dynamic = 'force-dynamic';

interface DealRow {
  [k: string]: unknown;
  id: string;
  title: string;
  description: string | null;
  stage: string;
  probability: number;
  expected_close_date: string | null;
  lost_reason: string | null;
  discount_centimes: string;
  company_id: string;
  company_name: string;
  company_retenue: boolean;
  owner_name: string | null;
}

interface LineRow {
  [k: string]: unknown;
  id: string;
  label: string;
  unit: string;
  unit_price_centimes: string;
  quantity_millis: string;
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (session?.user.role === 'member') redirect('/my-work');

  const data = await withUser(async (tx) => {
    const d = await tx.execute<DealRow>(sql`
      SELECT d.id, d.title, d.description, d.stage, d.probability,
             d.expected_close_date::text AS expected_close_date, d.lost_reason,
             d.discount_centimes::text, d.company_id, c.name AS company_name,
             c.retenue_source AS company_retenue, u.full_name AS owner_name
        FROM deal d
        JOIN company c ON c.id = d.company_id
        LEFT JOIN app_user u ON u.id = d.owner_id
       WHERE d.id = ${id}
    `);
    const record = d.rows[0];
    if (!record) return null;

    const lines = await tx.execute<LineRow>(sql`
      SELECT id, label, unit, unit_price_centimes::text, quantity_millis::text
        FROM deal_line WHERE deal_id = ${id} ORDER BY position, created_at
    `);

    // Only services with a price in force today, and still active.
    const services = await tx.execute<{
      [k: string]: unknown;
      id: string; name: string; unit: string; price: string;
    }>(sql`
      SELECT s.id, s.name, s.unit,
             coalesce((SELECT p.unit_price_centimes FROM service_price p
                        WHERE p.service_id = s.id AND p.effective_from <= current_date
                        ORDER BY p.effective_from DESC LIMIT 1), 0)::text AS price
        FROM service s WHERE s.is_active ORDER BY s.pillar, lower(s.name)
    `);

    // The VAT rate in force today, read from the versioned config table.
    const vat = await tx.execute<{ [k: string]: unknown; rate_bp: string }>(sql`
      SELECT rate_bp::text FROM fiscal_rate
       WHERE key = 'tva_standard' AND effective_from <= current_date
       ORDER BY effective_from DESC LIMIT 1
    `);

    return {
      record,
      lines: lines.rows,
      services: services.rows,
      vatRateBp: Number(vat.rows[0]?.rate_bp ?? 2000),
    };
  });

  if (!data) notFound();
  const { record, lines, services, vatRateBp } = data;

  // Every figure below is bigint centimes. Nothing here touches a float.
  const lineTotals = lines.map((l) =>
    lineTotal(BigInt(l.unit_price_centimes), BigInt(l.quantity_millis)),
  );
  const subtotal = sum(lineTotals);
  const discount = BigInt(record.discount_centimes);
  // A discount can never take the total below zero.
  const netExclVat = subtotal > discount ? subtotal - discount : 0n;

  const totals = computeTotals({
    lines: [{ unitPrice: netExclVat, quantity: 1000n }],
    vatRateBp,
    withholding: false,
    withholdingRateBp: 0,
  });

  return (
    <>
      <PageHeader
        eyebrow={record.company_name}
        title={record.title}
        actions={
          <Link href="/deals" className="btn btn-inverse">
            Back to deals
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <Field label="Stage" value={DEAL_STAGE_LABELS[record.stage]} />
          <Field label="Confidence" value={`${record.probability} %`} />
          <Field label="Owner" value={record.owner_name} />
        </div>
        <div>
          <Field
            label="Client"
            value={
              <Link
                href={`/companies/${record.company_id}`}
                className="underline underline-offset-4"
              >
                {record.company_name}
              </Link>
            }
          />
          <Field
            label="Expected close"
            value={record.expected_close_date ? formatDate(record.expected_close_date) : null}
          />
          <Field label="VAT rate" value={`${vatRateBp / 100} %`} />
        </div>
      </div>

      {record.description && <p className="prose-vixart mt-6">{record.description}</p>}
      {record.lost_reason && (
        <p className="prose-vixart mt-4">
          <span className="label">Lost because: </span>
          {record.lost_reason}
        </p>
      )}

      {/* --- Services on this deal ------------------------------------------ */}
      <Section title={`Services — ${lines.length}`}>
        {lines.length === 0 ? (
          <Empty message="No service on this deal yet. Pick one below and the total works itself out." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Service</th>
                  <th className="th py-2 pr-4 text-right">Unit price</th>
                  <th className="th py-2 pr-4 text-right">Qty</th>
                  <th className="th py-2 pr-4 text-right">Line total</th>
                  <th className="th py-2"></th>
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
                      {formatMAD(lineTotals[i] ?? 0n)}
                    </td>
                    <td className="py-2.5 text-right">
                      <form action={removeDealLineAction}>
                        <input type="hidden" name="lineId" value={line.id} />
                        <input type="hidden" name="dealId" value={record.id} />
                        <button
                          type="submit"
                          className="hint cursor-pointer underline underline-offset-4"
                        >
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {services.length === 0 ? (
          <p className="hint mt-4">
            No active service in the catalog.{' '}
            <Link href="/services" className="underline underline-offset-4">
              Add one first
            </Link>
            .
          </p>
        ) : (
          <AddLineForm
            action={addDealLineAction.bind(null, record.id)}
            services={services.map((s) => ({
              id: s.id,
              name: s.name,
              unit_label: SERVICE_UNIT_LABELS[s.unit] ?? s.unit,
              price: formatMAD(BigInt(s.price)),
            }))}
          />
        )}
      </Section>

      {/* --- Totals --------------------------------------------------------- */}
      <Section title="Total">
        <div className="max-w-md">
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Subtotal</span>
            <span className="code">{formatMAD(subtotal)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Discount</span>
            <span className="code">{discount > 0n ? `− ${formatMAD(discount)}` : '—'}</span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">Total excl. VAT</span>
            <span className="code font-semibold">{formatMAD(totals.totalExclVat)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b border-void/10 py-2">
            <span className="label">VAT {vatRateBp / 100} %</span>
            <span className="code">{formatMAD(totals.totalVat)}</span>
          </div>
          <div className="flex items-baseline justify-between border-b-2 border-void py-2.5">
            <span className="font-semibold">Total incl. VAT</span>
            <span className="code text-lg font-bold">{formatMAD(totals.totalInclVat)}</span>
          </div>
        </div>

        {record.company_retenue && (
          <p className="hint mt-3 max-w-md">
            This client withholds VAT at source (art. 117 bis). The net to collect
            is computed on the invoice, once the withholding rate is set in System.
          </p>
        )}

        <DiscountForm
          action={setDiscountAction.bind(null, record.id)}
          current={discount === 0n ? '' : fromCentimes(discount).replace('.', ',')}
        />
      </Section>
    </>
  );
}
