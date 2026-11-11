import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireClientPage } from './session';
import { withClient } from '@/db/session';
import { listPortalDocuments, listPortalProjects, readPortalInbox } from '@/lib/client-portal-queries';
import { summariseBilling } from '@/lib/client-relationship';
import { casablancaDay, formatDate } from '@/lib/format';
import { formatMAD } from '@/lib/money';
import { PortalTitle } from './PortalTitle';
import { PROJECT_STATUS } from './labels';

export const dynamic = 'force-dynamic';

/**
 * The overview: the three things a client opens the portal to find out.
 * Where is my work, do I owe anything, has anybody answered me. Each block
 * says it in one line and leads to the page with the detail.
 */
export default async function PortalHome() {
  const session = await requireClientPage();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const { projects, documents, inbox } = await withClient(session.user.id, async (tx) => ({
    projects: await listPortalProjects(tx),
    documents: await listPortalDocuments(tx),
    inbox: await readPortalInbox(tx),
  }));

  const today = casablancaDay();
  // Credit notes already taken off; below zero is credit in their favour,
  // which is not something they "still have to pay".
  const balance = summariseBilling(documents).outstanding;
  const owed = balance < 0n ? 0n : balance;
  const pastDue = documents.filter(
    (d) => d.doc_type === 'facture' && d.status === 'emis' && d.due_date !== null && d.due_date < today,
  ).length;
  const firstName = (session.user.name ?? '').split(' ')[0] || 'there';

  return (
    <>
      <PortalTitle
        eyebrow={session.user.companyName ?? ''}
        title={`Hello, ${firstName}.`}
        lead="Your projects, what you have been invoiced, and your conversation with the team — all in one place."
      />

      <div className="mt-10 grid gap-3 sm:grid-cols-2">
        <Link href="/portal/billing" className="vix-card px-6 py-6">
          <p className="vix-meta">Still to pay</p>
          <p className="vix-figure">{formatMAD(owed)}</p>
          <p className="vix-quiet mt-2">
            {owed === 0n
              ? 'You are up to date. See invoices and payments →'
              : pastDue > 0
                ? `${pastDue} invoice${pastDue === 1 ? ' is' : 's are'} past due. See invoices →`
                : 'See invoices and payments →'}
          </p>
        </Link>
        <Link href="/portal/support" className="vix-card px-6 py-6">
          <p className="vix-meta">Messages</p>
          <p className="vix-figure">{inbox.unread === 0 ? 'Up to date' : `${inbox.unread} new`}</p>
          <p className="vix-quiet mt-2">
            {inbox.unread === 0 ? 'Write to the team →' : `${inbox.unread === 1 ? 'A reply' : 'Replies'} from the team. Read →`}
          </p>
        </Link>
      </div>

      <section className="mt-16">
        <h2 className="vix-h2">Your projects</h2>
        {projects.length === 0 ? (
          <div className="vix-card mt-6 px-7 py-8">
            <p className="font-semibold">Nothing here yet.</p>
            <p className="vix-body mt-2">
              When we start a project for you it will appear here, with where it
              has got to. In the meantime you can write to us under “Messages”.
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-3">
            {projects.map((p) => {
              /*
               * The figure comes from the database (`app.project_progress`), so
               * this page and the team's cannot disagree. Nothing rather than a
               * confident 0% when there is genuinely nothing to report yet.
               */
              const pct = Number(p.percent ?? 0);
              const show = Number(p.total ?? 0) > 0 || pct > 0;
              return (
                <li key={p.id}>
                  <Link href={`/portal/projects/${p.id}`} className="vix-card px-6 py-6">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <h3 className="text-[19px] font-bold">{p.name}</h3>
                      <span className="vix-meta">{PROJECT_STATUS[p.status] ?? p.status}</span>
                    </div>
                    {p.next_step && (
                      <p className="vix-body mt-2">
                        <span className="vix-meta mr-2">Next</span>
                        {p.next_step}
                      </p>
                    )}
                    {show && (
                      <div className="mt-5 flex items-center gap-4">
                        <div
                          className="vix-track flex-1"
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${p.name} progress`}
                        >
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        <span className="vix-meta tabular-nums">{pct}%</span>
                      </div>
                    )}
                    <p className="vix-quiet mt-3">
                      {p.due_date ? <>Due {formatDate(p.due_date)} · </> : null}
                      {Number(p.delivered_files) > 0
                        ? `${p.delivered_files} file${Number(p.delivered_files) === 1 ? '' : 's'} delivered · `
                        : ''}
                      Open →
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
