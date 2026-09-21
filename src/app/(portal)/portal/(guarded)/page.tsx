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
      <p className="vix-meta">{session.user.companyName}</p>
      <h1 className="vix-h1 mt-4">Your work</h1>

      {projects.length === 0 ? (
        <div className="vix-card mt-10 px-7 py-8">
          <p className="font-semibold">Nothing here yet.</p>
          <p className="vix-body mt-2">
            When we start a project for you it will appear here, with where it
            has got to. In the meantime you can write to us under “Talk to us”.
          </p>
        </div>
      ) : (
        <ul className="mt-10">
          {projects.map((p) => {
            const total = Number(p.total ?? 0);
            const done = Number(p.done ?? 0);
            // A project with no steps yet has no honest percentage. Say nothing
            // rather than show a confident 0%.
            const pct = total > 0 ? Math.round((done / total) * 100) : null;

            return (
              <li key={p.id} className="vix-rule border-t py-9 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                  <h2 className="vix-h2">{p.name}</h2>
                  <span className="vix-meta">{STATUS[p.status] ?? p.status}</span>
                </div>

                {p.description && <p className="vix-body mt-3">{p.description}</p>}

                {pct !== null && (
                  <div className="mt-7 max-w-[560px]">
                    <div className="flex items-baseline justify-between">
                      <span className="vix-meta">Progress</span>
                      <span className="vix-meta tabular-nums">{pct}%</span>
                    </div>
                    <div
                      className="vix-track mt-2.5"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${p.name} progress`}
                    >
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <p className="vix-quiet mt-2">{done} of {total} steps done</p>
                  </div>
                )}

                {(p.start_date || p.due_date) && (
                  <p className="vix-quiet mt-5">
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

      <p className="vix-quiet vix-rule mt-14 border-t pt-6">
        Progress is counted from the steps we track internally. If something
        here does not match what you expect, tell us — that is what the
        conversation is for.
      </p>
    </>
  );
}
