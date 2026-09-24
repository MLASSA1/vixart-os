import { redirect } from 'next/navigation';
import { requireClientPage } from './session';
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
  const session = await requireClientPage();
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
            /*
             * The figure comes from the database, not from arithmetic here.
             *
             * It used to be computed on this line, which meant a project with
             * no task list had no honest percentage and showed nothing at all —
             * a client watching a film being made was told nothing was
             * happening. Amin and Mohamed Amine can now set the number
             * directly, and `app.project_progress` decides which of the two
             * applies so that this page and the internal one cannot disagree.
             *
             * Still nothing rather than a confident 0% when neither exists:
             * no tasks and nobody has set a figure means there is genuinely
             * nothing to report yet.
             */
            const pct = Number(p.percent ?? 0);
            const byHand = Boolean(p.by_hand);
            const show = total > 0 || pct > 0;
            /*
             * The step count, only when the bar IS the step count.
             *
             * Caught on the running page: with a hand-set 70% beside "1 of 2
             * steps done", a client does the division, gets 50, and reasonably
             * concludes that one of the two numbers is untrue. Neither is — the
             * count is simply not what the bar means once somebody has set it.
             */
            const showSteps = !byHand && total > 0;

            return (
              <li key={p.id} className="vix-rule border-t py-9 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                  <h2 className="vix-h2">{p.name}</h2>
                  <span className="vix-meta">{STATUS[p.status] ?? p.status}</span>
                </div>

                {p.description && <p className="vix-body mt-3">{p.description}</p>}

                {show && (
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
                    {showSteps && (
                      <p className="vix-quiet mt-2">{done} of {total} steps done</p>
                    )}
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

      {/*
        True whichever way the figure was arrived at.
        
        This said "progress is counted from the steps we track internally",
        which stopped being true the moment a figure could be set by hand — and
        a sentence to a client that is no longer true is worse than no sentence.
      */}
      <p className="vix-quiet vix-rule mt-14 border-t pt-6">
        Progress is where your producer says the work has got to. If something
        here does not match what you expect, tell us — that is what the
        conversation is for.
      </p>
    </>
  );
}
