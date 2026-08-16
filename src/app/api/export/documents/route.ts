import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { csvHeaders, toCsv } from '@/lib/csv';
import { fromCentimes } from '@/lib/money';

/**
 * Issued documents for the fiduciaire.
 *
 * Drafts are excluded: they have no number and no frozen figures, so they are
 * not documents yet. Amounts are plain decimals so the column can be summed.
 */
export const dynamic = 'force-dynamic';

const TYPE_FR: Record<string, string> = { devis: 'Devis', facture: 'Facture', avoir: 'Avoir' };
const STATUS_FR: Record<string, string> = { emis: 'Émis', paye: 'Payé', annule: 'Annulé' };

export async function GET() {
  const session = await auth();
  if (session?.user.role !== 'admin') return new NextResponse('Not found', { status: 404 });

  const rows = await withUser(async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT d.number, d.doc_type, d.status,
             d.issue_date::text AS issue_date, d.due_date::text AS due_date,
             coalesce(d.client_name, c.name) AS client, d.client_ice, d.client_if,
             d.total_excl_vat::text AS excl, d.vat_rate_bp,
             d.total_vat::text AS vat, d.total_incl_vat::text AS incl,
             d.withheld::text AS withheld, d.net_to_collect::text AS net, d.subject
        FROM document d JOIN company c ON c.id = d.company_id
       WHERE d.status <> 'brouillon'
       ORDER BY d.doc_type, d.number_year, d.number_seq
    `);
    return result.rows;
  });

  const csv = toCsv(
    ['Numero', 'Type', 'Statut', 'Date', 'Echeance', 'Client', 'ICE', 'IF',
     'Total HT', 'Taux TVA', 'TVA', 'Total TTC', 'Retenue source', 'Net a encaisser', 'Objet'],
    rows.map((r) => [
      r.number,
      TYPE_FR[r.doc_type as string] ?? r.doc_type,
      STATUS_FR[r.status as string] ?? r.status,
      r.issue_date, r.due_date, r.client, r.client_ice, r.client_if,
      fromCentimes(BigInt(String(r.excl))),
      `${Number(r.vat_rate_bp) / 100}%`,
      fromCentimes(BigInt(String(r.vat))),
      fromCentimes(BigInt(String(r.incl))),
      fromCentimes(BigInt(String(r.withheld))),
      fromCentimes(BigInt(String(r.net))),
      r.subject,
    ]),
  );

  return new NextResponse(csv, { headers: csvHeaders('vixart-documents.csv') });
}
