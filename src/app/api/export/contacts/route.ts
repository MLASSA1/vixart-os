import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { csvHeaders, toCsv } from '@/lib/csv';
import { whatsappLink } from '@/lib/format';

/**
 * Contact list for email and WhatsApp campaigns.
 *
 * Contacts marked opted out are excluded — consent is a property of the record,
 * not something to remember at export time.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user) return new NextResponse('Not found', { status: 404 });

  const rows = await withUser(async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      SELECT c.full_name, c.role_title, c.email, c.phone, c.whatsapp,
             co.name AS company, co.status::text AS stage, co.city, c.is_primary
        FROM contact c JOIN company co ON co.id = c.company_id
       WHERE NOT c.opted_out
       ORDER BY co.name, c.is_primary DESC, c.full_name
    `);
    return result.rows;
  });

  const csv = toCsv(
    ['Name', 'Role', 'Email', 'Phone', 'WhatsApp', 'WhatsApp link', 'Company', 'Stage', 'City', 'Main contact'],
    rows.map((r) => [
      r.full_name, r.role_title, r.email, r.phone, r.whatsapp,
      whatsappLink(r.whatsapp as string) ?? '',
      r.company, r.stage, r.city, r.is_primary ? 'yes' : '',
    ]),
  );

  return new NextResponse(csv, { headers: csvHeaders('vixart-contacts.csv') });
}
