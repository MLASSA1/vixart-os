import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { csvHeaders, toCsv } from '@/lib/csv';
import { fromCentimes } from '@/lib/money';

/** The full ledger for the accountant. Management only. */
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (session?.user.role !== 'admin') return new NextResponse('Not found', { status: 404 });

  const rows = await withUser(async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT f.entry_date::text AS entry_date, f.direction, f.category,
             f.payment_method, f.amount_centimes::text AS amount,
             f.vat_centimes::text AS vat, f.description, f.reference,
             c.name AS company, f.is_automatic
        FROM finance_entry f LEFT JOIN company c ON c.id = f.company_id
       ORDER BY f.entry_date, f.created_at
    `);
    return result.rows;
  });

  const csv = toCsv(
    ['Date', 'Sens', 'Categorie', 'Reglement', 'Montant', 'Dont TVA', 'Description',
     'Reference', 'Client', 'Automatique'],
    rows.map((r) => [
      r.entry_date,
      r.direction === 'income' ? 'Recette' : 'Depense',
      r.category, r.payment_method,
      fromCentimes(BigInt(String(r.amount))),
      fromCentimes(BigInt(String(r.vat))),
      r.description, r.reference, r.company,
      r.is_automatic ? 'oui' : 'non',
    ]),
  );

  return new NextResponse(csv, { headers: csvHeaders('vixart-finance.csv') });
}
