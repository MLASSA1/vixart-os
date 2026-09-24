import { redirect } from 'next/navigation';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { formatDate } from '@/lib/format';
import { OpenClientSpace } from './OpenClientSpace';
import { ProgressControl } from './ProgressControl';
import { DeactivateButton, ReissueForm } from './AccountControls';

/**
 * The client portal, from our side.
 *
 * One page for the two things that decide what a client sees: whether they can
 * sign in at all, and how far along their work says it is. Both were reachable
 * before — the account button lives on a company page and progress was a count
 * of tasks nobody could adjust — and reachable is not the same as findable.
 * Amin asked where accounts get made, which is the answer to whether the old
 * arrangement worked.
 *
 * Restricted to admin and moderator, which is Amin and Mohamed Amine. The nav
 * hides it from everybody else; this redirect is because a URL can be typed.
 */
export const dynamic = 'force-dynamic';

interface AccountRow {
  [k: string]: unknown;
  contact_id: string;
  full_name: string;
  email: string | null;
  company_id: string;
  company_name: string;
  is_active: boolean;
  must_change_password: boolean;
  last_sign_in_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ProjectRow {
  [k: string]: unknown;
  id: string;
  name: string;
  status: string;
  company_id: string;
  company_name: string;
  done: number;
  total: number;
  percent: number;
  by_hand: boolean;
  set_by: string | null;
  set_at: string | null;
  readers: number;
}

interface CompanyRow {
  [k: string]: unknown;
  id: string;
  name: string;
}

export default async function ClientPortalPage() {
  const session = await auth();
  const role = session?.user.role;
  if (role !== 'admin' && role !== 'moderator') redirect('/dashboard');

  const { accounts, projects, companies } = await withUser(async (tx) => {
    const accounts = await tx.execute<AccountRow>(sql`
      SELECT a.contact_id, c.full_name, c.email,
             c.company_id, co.name AS company_name,
             a.is_active, a.must_change_password,
             a.last_sign_in_at::text            AS last_sign_in_at,
             a.initial_password_expires_at::text AS expires_at,
             a.created_at::text                 AS created_at
        FROM client_account a
        JOIN contact c  ON c.id = a.contact_id
        JOIN company co ON co.id = c.company_id
       ORDER BY lower(co.name), lower(c.full_name)
    `);

    /*
     * Only the projects a client could actually be looking at.
     *
     * `readers` counts the active accounts on that company, and it is here
     * because setting the progress on a project nobody can see is a thing
     * somebody will do once and wonder about — so the page says so instead.
     */
    const projects = await tx.execute<ProjectRow>(sql`
      SELECT p.id, p.name, p.status, p.company_id, co.name AS company_name,
             pr.done, pr.total, pr.percent, pr.by_hand,
             u.full_name            AS set_by,
             p.progress_set_at::text AS set_at,
             (SELECT count(*)::int FROM client_account a
                JOIN contact ct ON ct.id = a.contact_id
               WHERE ct.company_id = p.company_id AND a.is_active) AS readers
        FROM project p
        JOIN company co ON co.id = p.company_id
        LEFT JOIN app_user u ON u.id = p.progress_set_by_id
        LEFT JOIN LATERAL app.project_progress(p.id) pr ON true
       WHERE EXISTS (SELECT 1 FROM client_account a
                       JOIN contact ct ON ct.id = a.contact_id
                      WHERE ct.company_id = p.company_id)
       ORDER BY lower(co.name),
                CASE p.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1
                              WHEN 'on_hold' THEN 2 ELSE 3 END,
                lower(p.name)
    `);

    const companies = await tx.execute<CompanyRow>(sql`
      SELECT id, name FROM company WHERE relationship = 'client' ORDER BY lower(name)
    `);

    return { accounts: accounts.rows, projects: projects.rows, companies: companies.rows };
  });

  const signedIn = accounts.filter((a) => a.last_sign_in_at !== null).length;

  return (
    <>
      <PageHeader
        eyebrow="Client portal"
        title="Who can sign in, and what they see"
      />

      <p className="prose-vixart" style={{ opacity: 0.68, maxWidth: '68ch' }}>
        An account lets one person sign in at{' '}
        <span className="font-semibold">client.visionxart.cloud</span> to see
        their own projects, read the progress, explore the systems and write to
        us. They see nothing belonging to any other client, and nothing of the
        team’s — not the channels, not the money, not the task list the progress
        was counted from.
      </p>

      <Section title="Open an account">
        <OpenClientSpace
          companies={companies.map((c) => ({ id: String(c.id), name: String(c.name) }))}
        />
      </Section>

      <Section
        title={
          accounts.length === 0
            ? 'Accounts'
            : `Accounts — ${accounts.length}, ${signedIn} signed in at least once`
        }
      >
        {accounts.length === 0 ? (
          <Empty message="No client has an account yet. Open the first one above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[14px]">
              <thead>
                <tr className="border-b border-void/10 text-left">
                  <th className="py-2 pr-4 font-semibold">Person</th>
                  <th className="py-2 pr-4 font-semibold">Client</th>
                  <th className="py-2 pr-4 font-semibold">Signs in</th>
                  <th className="py-2 pr-4 font-semibold">State</th>
                  <th className="py-2 font-semibold">{''}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={String(a.contact_id)} className="border-b border-void/[0.06]">
                    <td className="py-3 pr-4">
                      <span className="block font-semibold">{a.full_name}</span>
                      <span className="block text-[12.5px]" style={{ opacity: 0.55 }}>
                        {a.email}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <Link
                        href={`/companies/${a.company_id}`}
                        className="underline underline-offset-2"
                      >
                        {a.company_name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4">
                      {a.last_sign_in_at ? (
                        formatDate(String(a.last_sign_in_at))
                      ) : (
                        <span style={{ opacity: 0.55 }}>never</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {!a.is_active ? (
                        <span className="font-semibold">Turned off</span>
                      ) : a.must_change_password ? (
                        <>
                          <span>Invitation sent</span>
                          {a.expires_at && (
                            <span className="block text-[12.5px]" style={{ opacity: 0.55 }}>
                              expires {formatDate(String(a.expires_at))}
                            </span>
                          )}
                        </>
                      ) : (
                        <span>Active</span>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <ReissueForm contactId={String(a.contact_id)} />
                        <DeactivateButton
                          contactId={String(a.contact_id)}
                          active={Boolean(a.is_active)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Progress a client can see">
        {projects.length === 0 ? (
          <Empty message="No project belongs to a client with an account yet." />
        ) : (
          <>
            <p className="text-[14px]" style={{ opacity: 0.62, maxWidth: '68ch' }}>
              The bar a client reads. Left alone it counts finished tasks; set it
              by hand and that number is shown instead, until you clear it. The
              task count stays visible here either way, so a figure that has
              drifted from the work is something you can see rather than
              something that replaced it.
            </p>
            <ul className="mt-5">
              {projects.map((p) => (
                <li
                  key={String(p.id)}
                  className="border-t border-void/10 py-5 first:border-t-0 first:pt-1"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
                    <div className="min-w-0">
                      <Link
                        href={`/projects/${p.id}`}
                        className="text-[15px] font-semibold underline underline-offset-2"
                      >
                        {p.name}
                      </Link>
                      <span className="ml-2 text-[13px]" style={{ opacity: 0.55 }}>
                        {p.company_name}
                      </span>
                    </div>
                    <span className="text-[13px]" style={{ opacity: 0.55 }}>
                      {Number(p.total) > 0
                        ? `${p.done} of ${p.total} tasks done`
                        : 'no tasks'}
                      {p.by_hand && p.set_by && (
                        <>
                          {' · set by '}
                          {p.set_by}
                          {p.set_at && ` on ${formatDate(String(p.set_at))}`}
                        </>
                      )}
                      {Number(p.readers) === 0 && ' · nobody can see it yet'}
                    </span>
                  </div>

                  <ProgressControl
                    projectId={String(p.id)}
                    percent={Number(p.percent)}
                    byHand={Boolean(p.by_hand)}
                    fromTasks={
                      Number(p.total) > 0
                        ? Math.round((Number(p.done) / Number(p.total)) * 100)
                        : null
                    }
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}
