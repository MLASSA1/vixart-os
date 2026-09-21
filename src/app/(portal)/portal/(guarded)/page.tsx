import { redirect } from 'next/navigation';
import { requireClientSession } from '@/auth';
import { withClient } from '@/db/session';
import { listPortalProjects } from '@/lib/client-portal-queries';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, string> = {
  planned: 'Not started yet',
  active: 'In progress',
  on_hold: 'Paused',
  delivered: 'Delivered',
};

export default async function PortalHome() {
  const session = await requireClientSession();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const projects = await withClient(session.user.id, (tx) => listPortalProjects(tx));

  return (
    <>
      <p className="label" style={{ opacity: 0.6 }}>{session.user.companyName}</p>
      <h1 className="display mt-1 text-3xl font-bold tracking-tight">Your work</h1>

      {projects.length === 0 ? (
        <div className="card mt-8 px-6 py-8">
          <p className="font-semibold">Nothing here yet.</p>
          <p className="hint mt-1">
            When we start a project for you it will appear here, with where it
            has got to. In the meantime you can write to us under “Talk to us”.
          </p>
        </div>
      ) : (
        <ul className="mt-8 space-y-4">
          {projects.map((p) => {
            const total = Number(p.total ?? 0);
            const done = Number(p.done ?? 0);
            // A project with no tasks on it yet has no honest percentage. Say
            // nothing rather than show a confident 0%.
            const pct = total > 0 ? Math.round((done / total) * 100) : null;

            return (
              <li key={p.id} className="card px-6 py-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="display text-[17px] font-bold">{p.name}</h2>
                  <span className="chip tone-quiet">{STATUS[p.status] ?? p.status}</span>
                </div>

                {p.description && <p className="prose-vixart mt-2">{p.description}</p>}

                {pct !== null && (
                  <div className="mt-4">
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-void/10"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${p.name} progress`}
                    >
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="hint mt-1.5">
                      {pct}% — {done} of {total} steps done
                    </p>
                  </div>
                )}

                {(p.start_date || p.due_date) && (
                  <p className="hint mt-3">
                    {p.start_date && <>Started {formatDate(p.start_date)}</>}
                    {p.start_date && p.due_date && ' · '}
                    {p.due_date && <>Due {formatDate(p.due_date)}</>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="hint mt-8">
        Progress is counted from the steps we track internally. If something
        here does not match what you expect, tell us — that is what the
        conversation is for.
      </p>
    </>
  );
}
