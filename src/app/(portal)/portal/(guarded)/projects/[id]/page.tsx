import { notFound, redirect } from 'next/navigation';
import { requireClientPage } from '../../session';
import { withClient } from '@/db/session';
import { findPortalProject, listDeliveredFiles } from '@/lib/client-portal-queries';
import { formatDate, paragraphs } from '@/lib/format';
import { formatBytes } from '@/lib/upload-types';
import { PortalTitle } from '../../PortalTitle';
import { PROJECT_STATUS } from '../../labels';

export const dynamic = 'force-dynamic';

/**
 * One project, as the client sees it: where it has got to, what happens next,
 * and the files we have delivered.
 *
 * Read on the client connection: another company's project id, or an archived
 * one, is simply not found. "What happens next" is the sentence the team wrote
 * for the client (0086), never a task title; the files are only those somebody
 * chose to share.
 */
export default async function PortalProject({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireClientPage();
  if (session.user.mustChangePassword) redirect('/portal/account');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const data = await withClient(session.user.id, async (tx) => {
    const project = await findPortalProject(tx, id);
    if (!project) return null;
    return { project, files: await listDeliveredFiles(tx, id) };
  });
  if (!data) notFound();
  const { project: p, files } = data;

  const pct = Number(p.percent ?? 0);
  const total = Number(p.total ?? 0);
  const show = total > 0 || pct > 0;
  // The step count only when the bar IS the step count: "70%" beside "1 of 2
  // steps" invites the arithmetic, and one of them then looks untrue.
  const showSteps = !p.by_hand && total > 0;

  return (
    <>
      <PortalTitle eyebrow={session.user.companyName ?? ''} title={p.name} back={{ href: '/portal', label: 'Overview' }} />

      <dl className="vix-figures mt-10">
        <div>
          <dt className="vix-meta">Status</dt>
          <dd className="vix-figure">{PROJECT_STATUS[p.status] ?? p.status}</dd>
        </div>
        <div>
          <dt className="vix-meta">Progress</dt>
          <dd className="vix-figure">{show ? `${pct}%` : '—'}</dd>
          {show && (
            <dd className="mt-3">
              <div className="vix-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
                <span style={{ width: `${pct}%` }} />
              </div>
              {showSteps && <p className="vix-quiet mt-2">{Number(p.done)} of {total} steps done</p>}
            </dd>
          )}
        </div>
        <div>
          <dt className="vix-meta">Due</dt>
          <dd className="vix-figure">{p.due_date ? formatDate(p.due_date) : '—'}</dd>
          {p.start_date && <dd className="vix-quiet mt-1">Started {formatDate(p.start_date)}</dd>}
        </div>
      </dl>

      <section className="mt-14">
        <h2 className="vix-meta">What happens next</h2>
        {p.next_step ? (
          <>
            <p className="vix-lead mt-3 !text-white">{p.next_step}</p>
            {p.next_step_set_at && <p className="vix-quiet mt-2">Updated {formatDate(p.next_step_set_at)}</p>}
          </>
        ) : (
          <p className="vix-body mt-3">
            Your producer will write the next step here. If you want to know now, ask under “Messages”.
          </p>
        )}
      </section>

      {p.description && (
        <section className="mt-14">
          <h2 className="vix-meta">About this project</h2>
          {paragraphs(p.description).map((para, i) => (
            <p key={i} className="vix-body mt-3">{para}</p>
          ))}
        </section>
      )}

      <section className="mt-14">
        <h2 className="vix-h2">Delivered files</h2>
        {files.length === 0 ? (
          <p className="vix-body mt-4">Nothing delivered yet. Finished files will appear here, ready to download.</p>
        ) : (
          <ul className="mt-6">
            {files.map((f) => (
              <li key={f.id} className="vix-row">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{f.original_name}</p>
                  {f.caption && <p className="vix-quiet">{f.caption}</p>}
                  <p className="vix-quiet">Delivered {formatDate(f.shared_at)}</p>
                </div>
                <p className="vix-quiet tabular-nums">{formatBytes(Number(f.size_bytes))}</p>
                <a href={`/api/files/${f.id}`} className="vix-btn vix-btn-quiet vix-btn-small" target="_blank" rel="noopener">
                  Open
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
