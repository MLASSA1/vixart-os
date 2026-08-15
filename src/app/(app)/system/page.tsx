import { sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Field, PageHeader, Section } from '@/components/ui';
import { getOwnerDb } from '@/db';
import { withUser } from '@/db/session';

/**
 * Engine status. Management only.
 *
 * Reads the counters through the owner connection — this is a diagnostic of the
 * database itself, not a business screen — and separately proves that the
 * application role is genuinely fenced in by row level security.
 */
export const dynamic = 'force-dynamic';

export default async function SystemPage() {
  const session = await auth();
  if (session?.user.role !== 'admin') redirect('/clients');

  const owner = getOwnerDb();

  const [engine] = (
    await owner.execute<{
      version: string;
      database: string;
      data_directory: string;
      size: string;
    }>(sql`
      SELECT split_part(version(), ' ', 2)              AS version,
             current_database()                         AS database,
             current_setting('data_directory')          AS data_directory,
             pg_size_pretty(pg_database_size(current_database())) AS size
    `)
  ).rows;

  const [counters] = (
    await owner.execute<{
      migrations: string;
      clients: string;
      contacts: string;
      interactions: string;
      team: string;
      rates: string;
      forced_rls: string;
      policies: string;
    }>(sql`
      SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS migrations,
             (SELECT count(*) FROM client)::text       AS clients,
             (SELECT count(*) FROM contact)::text      AS contacts,
             (SELECT count(*) FROM interaction)::text  AS interactions,
             (SELECT count(*) FROM app_user)::text     AS team,
             (SELECT count(*) FROM fiscal_rate)::text  AS rates,
             (SELECT count(*) FROM pg_class
               WHERE relrowsecurity AND relforcerowsecurity
                 AND relnamespace = 'public'::regnamespace)::text AS forced_rls,
             (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')::text AS policies
    `)
  ).rows;

  // The same query through the application role, inside the signed-in context:
  // this is what the RLS policies actually let through.
  const visibleToMe = await withUser(async (tx) => {
    const result = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM client`,
    );
    return Number(result.rows[0]?.n ?? 0);
  });

  const rates = await withUser(async (tx) => {
    const result = await tx.execute<{
      key: string;
      rate_bp: number;
      effective_from: string;
      note: string | null;
    }>(sql`
      SELECT key, rate_bp, effective_from::text AS effective_from, note
        FROM fiscal_rate ORDER BY key, effective_from DESC
    `);
    return result.rows;
  });

  return (
    <>
      <PageHeader eyebrow="Management only" title="System" />

      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <h2 className="label border-b border-void pb-2">Engine</h2>
          <div className="mt-2">
            <Field label="PostgreSQL" value={engine?.version} />
            <Field label="Database" value={engine?.database} />
            <Field label="Data directory" value={engine?.data_directory} />
            <Field label="Size" value={engine?.size} />
            <Field label="Migrations applied" value={counters?.migrations} />
          </div>
        </div>

        <div className="mt-10 md:mt-0">
          <h2 className="label border-b border-void pb-2">Records</h2>
          <div className="mt-2">
            <Field label="Clients" value={counters?.clients} />
            <Field label="Contacts" value={counters?.contacts} />
            <Field label="Timeline entries" value={counters?.interactions} />
            <Field label="Team accounts" value={counters?.team} />
            <Field label="Tax parameters" value={counters?.rates} />
          </div>
        </div>
      </div>

      <Section title="Row level security">
        <div className="max-w-xl">
          <Field label="Tables under FORCE RLS" value={counters?.forced_rls} />
          <Field label="Active policies" value={counters?.policies} />
          <Field label="Clients visible to you" value={String(visibleToMe)} />
        </div>
        <p className="prose-vixart mt-4" style={{ opacity: 0.68 }}>
          FORCE means the policies apply even to the table owner. A
          misconfiguration that ran the application under the wrong role could not
          silently open the boundary.
        </p>
      </Section>

      <Section title="Tax parameters">
        <p className="prose-vixart mb-4" style={{ opacity: 0.68 }}>
          Versioned and immutable. Changing a rate means inserting a new dated
          version; a document already issued keeps the rate copied onto it.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-void">
                <th className="label py-2.5 pr-4">Key</th>
                <th className="label py-2.5 pr-4">Rate</th>
                <th className="label py-2.5 pr-4">In force from</th>
                <th className="label py-2.5">Note</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <tr
                  key={`${rate.key}-${rate.effective_from}`}
                  className="border-b border-void/10 align-top"
                >
                  <td className="code py-3 pr-4">{rate.key}</td>
                  <td className="code py-3 pr-4 whitespace-nowrap">
                    {(rate.rate_bp / 100).toString().replace('.', ',')} %
                  </td>
                  <td className="code py-3 pr-4">{rate.effective_from}</td>
                  <td className="py-3 text-[15px]" style={{ opacity: 0.68 }}>
                    {rate.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
