import Link from 'next/link';
import { ListFilter } from '@/components/ListFilter';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { ButtonLink, Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import {
  DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS, INVOICE_PAYMENT_METHOD_FR,
} from '@/lib/labels';
import { formatMAD } from '@/lib/money';
import { summariseBilling } from '@/lib/client-relationship';
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
  payment_method: string | null;
  company_name: string;
  company_id: string;
  issue_date: string | null;
  due_date: string | null;
  total_incl_vat: string;
  net_to_collect: string;
  paid: string;
  line_count: string;
}

/** Draft is outlined, issued is ruled, paid is solid, cancelled struck through. */
const STATUS_STYLE: Record<string, string> = {
  // Draft is quiet, issued is money still out the door, paid is settled.
  brouillon: 'tone-quiet border-dashed',
  emis: 'tone-warn',
  paye: 'tone-ok',
  annule: 'tone-quiet line-through opacity-70',
};

export default async function DocumentsPage() {
  const session = await auth();
  // Documents are money end to end: management only. The RLS policy would
  // return nothing anyway — redirect rather than show an empty screen.
  if (session?.user.role !== 'admin') redirect('/dashboard');

  const { rows, companies, deals } = await withUser(async (tx) => {
    const docs = await tx.execute<Row>(sql`
      SELECT d.id, d.doc_type, d.status, d.number, d.subject, d.payment_method,
             c.name AS company_name, c.id AS company_id,
             d.issue_date::text, d.due_date::text,
             d.total_incl_vat::text, d.net_to_collect::text,
             coalesce((SELECT sum(p.amount_centimes) FROM document_payment p
                        WHERE p.document_id = d.id), 0)::text AS paid,
             (SELECT count(*)::text FROM document_line l WHERE l.document_id = d.id) AS line_count
        FROM document d JOIN company c ON c.id = d.company_id
       ORDER BY CASE d.status WHEN 'brouillon' THEN 0 WHEN 'emis' THEN 1 ELSE 2 END,
                d.number DESC NULLS FIRST, d.created_at DESC
    `);
    const comps = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM company WHERE archived_at IS NULL ORDER BY lower(name)`,
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
  /*
   * Outstanding and collected come from the SAME function the client's own
   * page uses. They used to be worked out twice — here correctly, and there
   * counting quotes and credit notes as debt and ignoring deposits — so a
   * client's page and this one could show different amounts for the same
   * money. One definition, in src/lib/client-relationship.ts.
   */
  const { outstanding, collected } = summariseBilling(rows);

  const table = (list: Row[], emptyMessage: string, id: string) =>
    list.length === 0 ? (
      <Empty message={emptyMessage} />
    ) : (
      <div id={id} className="overflow-x-auto">
        <table className="table-wide text-left">
          <thead>
            <tr className="border-b-2 border-void/40">
              <th className="th py-2 pr-4">Number</th>
              <th className="th py-2 pr-4">Client</th>
              <th className="th py-2 pr-4">Status</th>
              {/* The document date, which a draft has and has not been issued on. */}
              <th className="th py-2 pr-4">Document date</th>
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
                  <span className={`chip ${STATUS_STYLE[row.status]}`}>
                    {DOCUMENT_STATUS_LABELS[row.status]}
                  </span>
                  {/*
                    How it is to be settled, under the status rather than in a
                    column of its own — this table is already five wide and the
                    answer is two words. A quote has no mode de règlement and a
                    draft has not chosen one yet, so neither prints a line.
                  */}
                  {row.payment_method && (
                    <p className="hint mt-0.5">
                      {INVOICE_PAYMENT_METHOD_FR[row.payment_method] ?? row.payment_method}
                    </p>
                  )}
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
        title="Quotes &amp; invoices"
        intro="Every quote and invoice, and what is still unpaid."
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
        {/*
          The two amounts take a full row each on a phone. An amount is one
          unbreakable token ("36 000,00 DH" uses non-breaking spaces), so in a
          half-width column it ran 23px into its neighbour and the screen read
          "36 000,00 DH0,00 DH" — two figures fused into one wrong number. The
          counts above are short and still share a row.
        */}
        <div className="col-span-2 md:col-span-1">
          <p className="label">Outstanding</p>
          {/* Credit notes are already taken off (summariseBilling). */}
          <p className="kpi kpi-money mt-1">{formatMAD(outstanding < 0n ? 0n : outstanding)}</p>
          <p className="hint mt-1">{unpaid.length} awaiting payment</p>
        </div>
        <div className="col-span-2 md:col-span-1">
          <p className="label">Collected</p>
          <p className="kpi kpi-money mt-1">{formatMAD(collected)}</p>
        </div>
      </div>

      <Section
        title={`Invoices — ${invoices.length}`}
        action={invoices.length > 0 && <ListFilter scope="invoice-list" placeholder="Search invoices" />}
      >
        {table(invoices, 'No invoice yet', 'invoice-list')}
      </Section>
      <Section
        title={`Quotes — ${quotes.length}`}
        action={quotes.length > 0 && <ListFilter scope="quote-list" placeholder="Search quotes" />}
      >
        {table(quotes, 'No quote yet', 'quote-list')}
      </Section>

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
