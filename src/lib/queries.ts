import { sql } from 'drizzle-orm';
import { withUser } from '@/db/session';
import type { CompanyRow } from '@/components/CompanyTable';

/**
 * Company list query, shared by Companies / Clients / Leads.
 *
 * `filter` is a SQL fragment, never a string interpolated from the URL — the
 * three call sites pass fixed fragments, and the free-text search goes through
 * a bound parameter.
 */
export async function listCompanies(options: {
  where?: ReturnType<typeof sql> | null;
  search?: string;
}): Promise<CompanyRow[]> {
  const search = (options.search ?? '').trim();
  const extra = options.where ?? sql`true`;

  return withUser(async (tx) => {
    const result = await tx.execute<CompanyRow & { [k: string]: unknown }>(sql`
      SELECT c.id, c.name, c.status::text AS status, c.relationship, c.city,
             c.engagement_summary,
             (SELECT ct.full_name FROM contact ct
               WHERE ct.company_id = c.id AND ct.is_primary LIMIT 1) AS primary_contact,
             (SELECT count(*)::text FROM contact ct WHERE ct.company_id = c.id) AS contact_count,
             (SELECT max(i.occurred_at) FROM interaction i WHERE i.company_id = c.id) AS last_contact
        FROM company c
       WHERE ${extra}
         AND (${search} = '' OR c.name ILIKE ${'%' + search + '%'}
                             OR coalesce(c.city, '') ILIKE ${'%' + search + '%'}
                             OR coalesce(c.engagement_summary, '') ILIKE ${'%' + search + '%'})
       ORDER BY CASE c.status
                  WHEN 'client' THEN 0 WHEN 'prospect' THEN 1
                  WHEN 'lead' THEN 2 ELSE 3 END,
                lower(c.name)
    `);
    return result.rows as CompanyRow[];
  });
}
