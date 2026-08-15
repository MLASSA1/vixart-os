import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { PROJECT_STATUS_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';
import { ProjectForm } from './ProjectForm';
import { saveProjectAction, setProjectStatusAction } from './actions';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string;
  name: string;
  status: string;
  company_id: string;
  company_name: string;
  lead_name: string | null;
  due_date: string | null;
  open_tasks: string;
  awaiting: string;
  total_tasks: string;
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-void text-pure border border-void',
  planned: 'border-2 border-void',
  on_hold: 'border border-dashed border-void',
  delivered: 'border border-void/35 text-void/50',
};

export default async function ProjectsPage() {
  const session = await auth();
  const canModerate =
    session?.user.role === 'admin' || session?.user.role === 'moderator';

  const { rows, companies, team } = await withUser(async (tx) => {
    const projects = await tx.execute<Row>(sql`
      SELECT p.id, p.name, p.status, p.company_id, c.name AS company_name,
             u.full_name AS lead_name, p.due_date::text AS due_date,
             (SELECT count(*)::text FROM task t
               WHERE t.project_id = p.id AND t.status IN ('todo','in_progress')) AS open_tasks,
             (SELECT count(*)::text FROM task t
               WHERE t.project_id = p.id AND t.status = 'submitted') AS awaiting,
             (SELECT count(*)::text FROM task t WHERE t.project_id = p.id) AS total_tasks
        FROM project p
        JOIN company c ON c.id = p.company_id
        LEFT JOIN app_user u ON u.id = p.lead_id
       ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1
                              WHEN 'on_hold' THEN 2 ELSE 3 END,
                p.due_date NULLS LAST, lower(p.name)
    `);
    const comps = await tx.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM company ORDER BY lower(name)`,
    );
    const members = await tx.execute<{ id: string; full_name: string }>(
      sql`SELECT id, full_name FROM app_user WHERE is_active ORDER BY full_name`,
    );
    return { rows: projects.rows, companies: comps.rows, team: members.rows };
  });

  return (
    <>
      <PageHeader eyebrow="Delivery" title="Projects" />

      <Section title={`All projects — ${rows.length}`}>
        {rows.length === 0 ? (
          <Empty message="No project yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-void">
                  <th className="th py-2 pr-4">Project</th>
                  <th className="th py-2 pr-4">Status</th>
                  <th className="th py-2 pr-4">Lead</th>
                  <th className="th py-2 pr-4 text-right">Tasks</th>
                  <th className="th py-2 pr-4">Due</th>
                  {canModerate && <th className="th py-2">Move to</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-void/10 align-top">
                    <td className="py-3 pr-4">
                      <Link
                        href={`/projects/${row.id}`}
                        className="font-semibold underline-offset-4 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <p className="hint mt-0.5">{row.company_name}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${
                          STATUS_STYLE[row.status]
                        }`}
                      >
                        {PROJECT_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="hint py-3 pr-4">{row.lead_name ?? '—'}</td>
                    <td className="py-3 pr-4 text-right">
                      <span className="figure">{row.open_tasks}</span>
                      <span className="hint"> open / {row.total_tasks}</span>
                      {Number(row.awaiting) > 0 && (
                        <p className="hint">{row.awaiting} awaiting sign-off</p>
                      )}
                    </td>
                    <td className="hint py-3 pr-4 whitespace-nowrap">
                      {row.due_date ? formatDate(row.due_date) : '—'}
                    </td>
                    {canModerate && (
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {['planned', 'active', 'on_hold', 'delivered']
                            .filter((s) => s !== row.status)
                            .map((s) => (
                              <form key={s} action={setProjectStatusAction}>
                                <input type="hidden" name="projectId" value={row.id} />
                                <input type="hidden" name="status" value={s} />
                                <button type="submit" className="btn btn-inverse btn-small">
                                  {PROJECT_STATUS_LABELS[s]}
                                </button>
                              </form>
                            ))}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {canModerate && (
        <Section title="Start a project">
          <ProjectForm
            action={saveProjectAction.bind(null, null)}
            companies={companies}
            team={team}
            submitLabel="Create project"
          />
        </Section>
      )}
    </>
  );
}
