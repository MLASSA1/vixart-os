import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { ButtonLink, Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS } from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { NewDocumentForm } from './NewDocumentForm';
import { createDocumentAction } from './actions';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string;
  doc_type: string;
  status: string;
  number: string | null;
  subject: string | null;
  company_name: string;
  company_id: string;
  issue_date: string | null;
  due_date: string | null;
  total_incl_vat: string;
  net_to_collect: string;
  line_count: string;
}

/** Draft is outlined, issued is ruled, paid is solid, cancelled struck through. */
const STATUS_STYLE: Record<string, string> = {
  brouillon: 'border border-dashed border-void/50',
  emis: 'border-2 border-void',
  paye: 'bg-void text-pure border border-void',
  annule: 'border border-void/35 text-void/50 line-through',
};

export default async function DocumentsPage() {
  const session = await auth();
  // Documents are money end to end: management only. The RLS policy would
  // return nothing anyway — redirect rather than show an empty screen.
  if (session?.user.role !== 'admin') redirect('/dashboard');

  const { rows, companies, deals } = await withUser(async (tx) => {
    const docs = await tx.execute<Row>(sql`
      SELECT d.id, d.doc_type, d.status, d.number, d.subject,
             c.name AS company_name, c.id AS company_id,
             d.issue_date::text, d.due_date::text,
             d.total_incl_vat::text, d.net_to_collect::text,
             (SELECT count(*)::text FROM document_line l WHERE l.document_id = d.id) AS line_count
        FROM document d JOIN company c ON c.id = d.company_id
       ORDER BY CASE d.status WHEN 'brouillon' THEN 0 WHEN 'emis' THEN 1 ELSE 2 END,
                d.number DESC NULLS FIRST, d.created_at DESC
    `);
    const comps = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM company ORDER BY lower(name)`,
    );
    const openDeals = await tx.execute<{ id: string; label: string }>(sql`
      SELECT d.id, d.title || ' — ' || c.name AS label
        FROM deal d JOIN company c ON c.id = d.company_id
       WHERE d.stage <> 'lost' ORDER BY d.created_at DESC
    `);
    return { rows: docs.rows, companies: comps.rows, deals: openDeals.rows };
  });

  const quotes = rows.filter((r) => r.doc_type === 'devis');
  const invoices = rows.filter((r) => r.doc_type === 'facture');
  const unpaid = invoices.filter((r) => r.status === 'emis');
  const outstanding = unpaid.reduce<bigint>((a, r) => a + BigInt(r.net_to_collect), 0n);
  const collected = invoices
    .filter((r) => r.status === 'paye')
    .reduce<bigint>((a, r) => a + BigInt(r.net_to_collect), 0n);

  const table = (list: Row[], emptyMessage: string) =>
    list.length === 0 ? (
      <Empty message={emptyMessage} />
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b-2 border-void">
              <th className="th py-2 pr-4">Number</th>
              <th className="th py-2 pr-4">Client</th>
              <th className="th py-2 pr-4">Status</th>
              <th className="th py-2 pr-4">Issued</th>
              <th className="th py-2 text-right">Total incl. VAT</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.id} className="border-b border-void/10 align-top">
                <td className="py-3 pr-4">
                  <Link
                    href={`/documents/${row.id}`}
                    className="code font-semibold underline-offset-4 hover:underline"
                  >
                    {row.number ?? 'Draft'}
                  </Link>
                  {row.subject && <p className="hint mt-0.5">{row.subject}</p>}
                  {Number(row.line_count) === 0 && (
                    <p className="hint mt-0.5">no lines yet</p>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <Link
                    href={`/companies/${row.company_id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {row.company_name}
                  </Link>
                </td>
                <td className="py-3 pr-4">
                  <span
                    className={`inline-block px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${
                      STATUS_STYLE[row.status]
                    }`}
                  >
                    {DOCUMENT_STATUS_LABELS[row.status]}
                  </span>
                </td>
                <td className="hint py-3 pr-4 whitespace-nowrap">
                  {row.issue_date ? formatDate(row.issue_date) : '—'}
                </td>
                <td className="code py-3 text-right whitespace-nowrap">
                  {row.status === 'brouillon'
                    ? '—'
                    : formatMAD(BigInt(row.total_incl_vat))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title="Quotes &amp; invoices"
        actions={<ButtonLink href="/documents/new">New document</ButtonLink>}
      />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Quotes</p>
          <p className="kpi mt-1">{quotes.length}</p>
        </div>
        <div>
          <p className="label">Invoices</p>
          <p className="kpi mt-1">{invoices.length}</p>
        </div>
        <div>
          <p className="label">Outstanding</p>
          <p className="kpi mt-1">{formatMAD(outstanding)}</p>
          <p className="hint mt-1">{unpaid.length} awaiting payment</p>
        </div>
        <div>
          <p className="label">Collected</p>
          <p className="kpi mt-1">{formatMAD(collected)}</p>
        </div>
      </div>

      <Section title={`Invoices — ${invoices.length}`}>{table(invoices, 'No invoice yet')}</Section>
      <Section title={`Quotes — ${quotes.length}`}>{table(quotes, 'No quote yet')}</Section>

      <Section title="New document">
        <NewDocumentForm
          action={createDocumentAction}
          companies={companies}
          deals={deals}
        />
        <p className="hint mt-3">
          Starting from a deal copies its services and discount across, so the
          client sees the figures you already discussed.
        </p>
      </Section>
    </>
  );
}
