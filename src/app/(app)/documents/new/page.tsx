import { sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { PageHeader } from '@/components/ui';
import { withUser } from '@/db/session';
import { buildDocumentAction } from '../actions';
import { Builder, type ClientOption, type ServiceOption } from './Builder';

export const dynamic = 'force-dynamic';

/**
 * One screen from blank to a document ready to print.
 *
 * The catalog price loaded here is whichever version is in force today. It
 * fills the row and is then editable, and whatever is typed is what the
 * document keeps — a price on an issued invoice must never move because
 * someone later edited the catalog.
 */
export default async function NewDocumentPage() {
  const session = await auth();
  if (session?.user.role !== 'admin') redirect('/dashboard');

  const data = await withUser(async (tx) => {
    const clients = await tx.execute<Record<string, unknown>>(sql`
      SELECT c.id, c.name, c.legal_name, c.ice, c.identifiant_fiscal,
             nullif(concat_ws(', ', nullif(c.address_line,''), nullif(c.city,'')), '') AS address,
             c.retenue_source
        FROM company c
       -- Every status can be billed: a lead becomes a client the moment they
       -- accept a quote, and refusing to quote a lead would be backwards.
       ORDER BY lower(c.name)
    `);

    const services = await tx.execute<Record<string, unknown>>(sql`
      SELECT s.id, s.name, s.unit,
             coalesce((SELECT p.unit_price_centimes FROM service_price p
                        WHERE p.service_id = s.id AND p.effective_from <= current_date
                        ORDER BY p.effective_from DESC LIMIT 1), 0)::text AS price
        FROM service s
       WHERE s.is_active
       ORDER BY lower(s.name)
    `);

    const rates = await tx.execute<{ [k: string]: unknown; vat: string; wh: string }>(sql`
      SELECT coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key='tva_standard' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 2000)::text AS vat,
             coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key='retenue_source_tva' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 0)::text AS wh
    `);

    return { clients: clients.rows, services: services.rows, rates: rates.rows[0] };
  });

  const clients: ClientOption[] = data.clients.map((c) => ({
    id: String(c.id),
    name: String(c.name),
    legalName: (c.legal_name as string) ?? null,
    ice: (c.ice as string) ?? null,
    taxId: (c.identifiant_fiscal as string) ?? null,
    address: (c.address as string) ?? null,
    retenueSource: Boolean(c.retenue_source),
  }));

  const services: ServiceOption[] = data.services.map((s) => ({
    id: String(s.id),
    name: String(s.name),
    unitLabel: String(s.unit),
    priceCentimes: String(s.price),
  }));

  // The server's date, not the browser's: a document dated by whichever
  // timezone the laptop happens to be in is a document dated wrongly.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });

  return (
    <>
      <PageHeader eyebrow="Documents" title="New document" />
      <Builder
        action={buildDocumentAction}
        clients={clients}
        services={services}
        today={today}
        defaultVatRateBp={Number(data.rates?.vat ?? 2000)}
        withholdingRateBp={Number(data.rates?.wh ?? 0)}
      />
    </>
  );
}
