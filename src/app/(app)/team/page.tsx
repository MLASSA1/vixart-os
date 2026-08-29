import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { formatDate } from '@/lib/format';
import {
  createMemberAction,
  deleteMemberAction,
  resetPasswordAction,
  setActiveAction,
  setRoleAction,
  updateMemberAction,
} from './actions';
import { AddMemberForm, EditMemberForm, ResetPasswordForm } from './TeamForms';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string; full_name: string; email: string; job_title: string | null;
  role: string; is_active: boolean; must_change_password: boolean;
  created_at: string;
  open_tasks: string; done_tasks: string; timeline_entries: string;
  /** Anything they have touched — a record with history is never deleted. */
  has_history: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  moderator: 'Moderator',
  member: 'Team',
};

/** Reach is marked with the accent; everyone else stays quiet. */
const ROLE_STYLE: Record<string, string> = {
  admin: 'tone-accent',
  moderator: 'tone-quiet font-semibold',
  member: 'tone-quiet',
};

const ROLE_EXPLAINS: Record<string, string> = {
  admin: 'Finance, invoices, prices, accounts.',
  moderator: 'Assigns work and signs off completion.',
  member: 'Own tasks, clients and projects.',
};

export default async function TeamPage() {
  const session = await auth();
  const isAdmin = session?.user.role === 'admin';
  const me = session?.user.id;

  const members = await withUser(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT u.id, u.full_name, u.email, u.job_title, u.role, u.is_active,
             u.must_change_password, u.created_at::text,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status <> 'completed') AS open_tasks,
             (SELECT count(*)::text FROM task t
               WHERE t.assignee_id = u.id AND t.status = 'completed')  AS done_tasks,
             (SELECT count(*)::text FROM interaction i WHERE i.author_id = u.id) AS timeline_entries,
             (EXISTS (SELECT 1 FROM task t WHERE t.assignee_id = u.id)
              OR EXISTS (SELECT 1 FROM interaction i WHERE i.author_id = u.id)
              OR EXISTS (SELECT 1 FROM activity a WHERE a.actor_id = u.id)) AS has_history
        FROM app_user u
       ORDER BY u.is_active DESC,
                CASE u.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
                lower(u.full_name)
    `);
    return result.rows;
  });

  const active = members.filter((m) => m.is_active);
  const admins = active.filter((m) => m.role === 'admin');

  return (
    <>
      <PageHeader eyebrow="The agency" title="Team" />

      <div className="grid grid-cols-2 gap-6 border-b border-void/15 pb-6 md:grid-cols-4">
        <div>
          <p className="label">Active accounts</p>
          <p className="kpi mt-1">{active.length}</p>
        </div>
        <div>
          <p className="label">Administrators</p>
          <p className="kpi mt-1">{admins.length}</p>
          {admins.length === 1 && (
            <p className="hint mt-1">
              Only one. Promote a second so a lost password is not a locked door.
            </p>
          )}
        </div>
        <div>
          <p className="label">Open tasks</p>
          <p className="kpi mt-1">
            {active.reduce((a, m) => a + Number(m.open_tasks), 0)}
          </p>
        </div>
        <div>
          <p className="label">Still on the initial password</p>
          <p className="kpi mt-1">
            {active.filter((m) => m.must_change_password).length}
          </p>
        </div>
      </div>

      <Section title={`Accounts — ${members.length}`}>
        <ul className="border-t border-void/10">
          {members.map((m) => {
            const isMe = m.id === me;
            const lastAdmin = m.role === 'admin' && m.is_active && admins.length === 1;

            return (
              <li key={m.id} className="border-b border-void/10 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                  <div className="min-w-0">
                    <span
                      className={`font-semibold ${m.is_active ? '' : 'opacity-50 line-through'}`}
                    >
                      {m.full_name}
                    </span>
                    {isMe && <span className="hint ml-2">you</span>}
                    {m.must_change_password && m.is_active && (
                      <span className="ml-3 inline-block border border-void px-2 py-0.5 text-[12.5px] font-medium">
                        Initial password
                      </span>
                    )}
                    <p className="hint">
                      {m.job_title ?? '—'} · {m.email}
                    </p>
                    <p className="hint">
                      {m.open_tasks} open · {m.done_tasks} completed ·{' '}
                      {m.timeline_entries} timeline entries · since {formatDate(m.created_at)}
                    </p>
                  </div>

                  <div className="text-right">
                    <span
                      className={`inline-block px-2.5 py-1 text-[12.5px] font-medium leading-none ${
                        ROLE_STYLE[m.role]
                      }`}
                    >
                      {ROLE_LABEL[m.role] ?? m.role}
                    </span>
                    <p className="hint mt-1 max-w-52">{ROLE_EXPLAINS[m.role]}</p>
                    {!m.is_active && <p className="hint mt-1">Deactivated — cannot sign in</p>}
                  </div>
                </div>

                {isAdmin && (
                  <details className="mt-2">
                    <summary className="hint cursor-pointer">Manage</summary>
                    <div className="border-l border-void/20 pt-2 pl-4">
                      <EditMemberForm
                        action={updateMemberAction.bind(null, m.id)}
                        fullName={m.full_name}
                        jobTitle={m.job_title}
                      />

                      {/* --- Role ------------------------------------------ */}
                      <div className="mt-5">
                        <p className="label">Access</p>
                        {isMe ? (
                          <p className="hint mt-1 max-w-lg">
                            You cannot change your own role — another administrator has
                            to. The database refuses it, so an accidental self-demotion
                            cannot lock you out.
                          </p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(['member', 'moderator', 'admin'] as const)
                              .filter((r) => r !== m.role)
                              .map((r) => (
                                <form key={r} action={setRoleAction}>
                                  <input type="hidden" name="userId" value={m.id} />
                                  <input type="hidden" name="role" value={r} />
                                  <button
                                    type="submit"
                                    className="btn btn-small btn-inverse"
                                    disabled={lastAdmin}
                                  >
                                    Make {ROLE_LABEL[r]}
                                  </button>
                                </form>
                              ))}
                          </div>
                        )}
                        {lastAdmin && !isMe && (
                          <p className="hint mt-2 max-w-lg">
                            This is the only administrator. Promote someone else first —
                            the database refuses to leave the agency without one.
                          </p>
                        )}
                      </div>

                      {/* --- Password ---------------------------------------- */}
                      {!isMe && (
                        <div className="mt-5">
                          <p className="label">Locked out?</p>
                          <ResetPasswordForm action={resetPasswordAction.bind(null, m.id)} />
                        </div>
                      )}

                      {/* --- Access ------------------------------------------ */}
                      {!isMe && (
                        <div className="mt-5">
                          <p className="label">
                            {m.is_active ? 'Remove from the team' : 'Bring back'}
                          </p>
                          <p className="hint mt-1 max-w-lg">
                            {m.is_active
                              ? 'Deactivating stops them signing in and keeps their name on the work they did. This is how someone leaves.'
                              : 'They will be able to sign in again with their existing password.'}
                          </p>
                          <form action={setActiveAction} className="mt-2">
                            <input type="hidden" name="userId" value={m.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={m.is_active ? 'false' : 'true'}
                            />
                            <button type="submit" className="btn btn-small" disabled={lastAdmin}>
                              {m.is_active ? 'Deactivate account' : 'Reactivate account'}
                            </button>
                          </form>
                        </div>
                      )}

                      {/* --- Permanent deletion, only when there is no trace -- */}
                      {!isMe && !m.has_history && (
                        <div className="mt-5">
                          <p className="label">Delete permanently</p>
                          <p className="hint mt-1 max-w-lg">
                            This account has no history — nothing assigned, written or
                            recorded — so it can be removed outright. Once it has done
                            any work, deactivate it instead so the record stays intact.
                          </p>
                          <form
                            action={deleteMemberAction}
                            className="mt-2 flex flex-wrap items-end gap-3"
                          >
                            <input type="hidden" name="userId" value={m.id} />
                            <input type="hidden" name="expected" value={m.email} />
                            <label className="block" htmlFor={`confirm-${m.id}`}>
                              <span className="label block">
                                Type {m.email} to confirm
                              </span>
                              <input
                                id={`confirm-${m.id}`}
                                name="confirmation"
                                autoComplete="off"
                                className="input w-72"
                              />
                            </label>
                            <button type="submit" className="btn btn-small">
                              Delete
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      {isAdmin && (
        <Section title="Add someone">
          <AddMemberForm action={createMemberAction} />
        </Section>
      )}

      <p className="prose-vixart mt-10 text-[15px]" style={{ opacity: 0.55 }}>
        Administrators see Finance, invoices and service prices. Moderators assign
        work and sign off completed tasks. The team sees clients, projects and
        their own work. The boundary is enforced by PostgreSQL row level security,
        not by hiding menu entries.
      </p>
    </>
  );
}
