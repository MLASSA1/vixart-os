import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { PageHeader, Section } from '@/components/ui';
import { ActivityFeed, type ActivityItem } from '@/components/ActivityFeed';
import { withUser } from '@/db/session';
import { ROLE_LABELS } from '@/lib/labels';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface MemberRow {
  [k: string]: unknown;
  id: string;
  full_name: string;
  email: string;
  job_title: string | null;
  role: string;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
  open_tasks: string;
  in_progress: string;
  awaiting: string;
  overdue: string;
  completed: string;
  projects_led: string;
}

/**
 * Team — the directory plus the workload overview from the diagram's Team
 * Management module. Everyone can read it: assigning work needs to know who is
 * already loaded.
 */
export default async function TeamPage() {
  const session = await auth();
  const canModerate =
    session?.user.role === 'admin' || session?.user.role === 'moderator';

  const { members, activity } = await withUser(async (tx) => {
    const rows = await tx.execute<MemberRow>(sql`
      SELECT u.id, u.full_name, u.email, u.job_title, u.role, u.is_active,
             u.must_change_password, u.created_at::text,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status IN ('todo','in_progress')) AS open_tasks,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status = 'in_progress') AS in_progress,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status = 'submitted') AS awaiting,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status IN ('todo','in_progress')
                 AND t.due_date IS NOT NULL AND t.due_date < current_date) AS overdue,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status = 'completed') AS completed,
             (SELECT count(*)::text FROM project p WHERE p.lead_id = u.id) AS projects_led
        FROM app_user u
       ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
                u.full_name
    `);

    const feed = await tx.execute<ActivityItem & { [k: string]: unknown }>(sql`
      SELECT id, actor_name, entity_type, entity_label, action, created_at::text
        FROM activity ORDER BY created_at DESC LIMIT 25
    `);

    return { members: rows.rows, activity: feed.rows as ActivityItem[] };
  });

  const totalOpen = members.reduce((a, m) => a + Number(m.open_tasks), 0);
  const busiest = Math.max(1, ...members.map((m) => Number(m.open_tasks)));

  return (
    <>
      <PageHeader eyebrow="VIXART" title="Team" />

      <Section title="Workload">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-void">
                <th className="th py-2 pr-4">Member</th>
                <th className="th py-2 pr-4">Access</th>
                <th className="th py-2 pr-4">Load</th>
                <th className="th py-2 pr-4 text-right">Open</th>
                <th className="th py-2 pr-4 text-right">Overdue</th>
                <th className="th py-2 pr-4 text-right">Awaiting</th>
                <th className="th py-2 text-right">Done</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const open = Number(m.open_tasks);
                // Load bar: proportion of the busiest person's queue. Achromatic
                // by design — a filled rule, never a coloured meter.
                const share = Math.round((open / busiest) * 100);
                return (
                  <tr key={m.id} className="border-b border-void/10">
                    <td className="py-3 pr-4">
                      <span className="font-semibold">{m.full_name}</span>
                      {m.must_change_password && (
                        <span className="hint ml-2">· initial password</span>
                      )}
                      <p className="hint">{m.job_title ?? m.email}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap ${
                          m.role === 'admin'
                            ? 'bg-void text-pure border border-void'
                            : m.role === 'moderator'
                              ? 'border-2 border-void'
                              : 'border border-void/40'
                        }`}
                      >
                        {ROLE_LABELS[m.role] ?? m.role}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        aria-hidden="true"
                        className="block h-2 border border-void/30"
                        style={{ width: 96 }}
                      >
                        <span
                          className="block h-full bg-void"
                          style={{ width: `${open === 0 ? 0 : Math.max(share, 6)}%` }}
                        />
                      </span>
                      <span className="sr-only">{open} open tasks</span>
                    </td>
                    <td className="figure py-3 pr-4 text-right">{m.open_tasks}</td>
                    <td className="figure py-3 pr-4 text-right">
                      {Number(m.overdue) > 0 ? <strong>{m.overdue}</strong> : m.overdue}
                    </td>
                    <td className="figure py-3 pr-4 text-right">{m.awaiting}</td>
                    <td className="figure py-3 text-right" style={{ opacity: 0.6 }}>
                      {m.completed}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint mt-3">
          {totalOpen} open task{totalOpen === 1 ? '' : 's'} across the team.
          {canModerate
            ? ' Assign work from a project.'
            : ' Only a moderator assigns work.'}
        </p>
      </Section>

      <Section title="Roles">
        <div className="prose-vixart space-y-2">
          <p>
            <strong>Management</strong> — Amin. Everything, including finance,
            service prices and deal values.
          </p>
          <p>
            <strong>Work moderator</strong> — Mohamed Amine. Assigns tasks, shapes
            projects, and signs off completion after a member submits.
          </p>
          <p>
            <strong>Team</strong> — sees clients, projects and their own tasks. Never
            prices, deal values or the P&amp;L.
          </p>
          <p className="hint">
            Enforced by PostgreSQL row level security, not by hiding menu entries —
            a member querying a price gets nothing back.
          </p>
        </div>
      </Section>

      <Section title="Recent activity">
        <ActivityFeed items={activity} />
      </Section>

      <Section title="Accounts">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-void">
                <th className="th py-2 pr-4">Name</th>
                <th className="th py-2 pr-4">Email</th>
                <th className="th py-2 pr-4 text-right">Projects led</th>
                <th className="th py-2 text-right">Since</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-void/10">
                  <td className="py-2.5 pr-4">{m.full_name}</td>
                  <td className="code py-2.5 pr-4">{m.email}</td>
                  <td className="figure py-2.5 pr-4 text-right">{m.projects_led}</td>
                  <td className="hint py-2.5 text-right">{formatDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
