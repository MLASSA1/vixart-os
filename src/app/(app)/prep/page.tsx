import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { formatDate } from '@/lib/format';
import { createPrepAction } from './actions';
import { NewPrepForm } from './PrepForms';
import { PREP_KIND_LABELS } from '@/lib/labels';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string;
  title: string;
  kind: string;
  status: string;
  owner_id: string;
  owner_name: string;
  project_name: string | null;
  ready_at: string | null;
  updated_at: string;
  file_count: string;
  comment_count: string;
}

/**
 * Everyone's preparation, in two halves: what you are working on, and what the
 * team has finished and shared.
 *
 * The split is not a UI convenience — the database returns nothing else. A
 * colleague's draft is not hidden by this page, it is invisible to the query.
 */
export default async function PrepPage() {
  const session = await auth();
  const me = session!.user;

  const { rows, projects } = await withUser(async (tx) => {
    const list = await tx.execute<Row>(sql`
      SELECT p.id, p.title, p.kind, p.status, p.owner_id,
             u.full_name AS owner_name,
             pr.name AS project_name,
             p.ready_at::text, p.updated_at::text,
             (SELECT count(*)::text FROM attachment a
               WHERE a.entity_type='prep' AND a.entity_id = p.id) AS file_count,
             (SELECT count(*)::text FROM comment c
               WHERE c.entity_type='prep' AND c.entity_id = p.id) AS comment_count
        FROM prep p
        JOIN app.team_directory u ON u.id = p.owner_id
        LEFT JOIN project pr ON pr.id = p.project_id
       ORDER BY coalesce(p.ready_at, p.updated_at) DESC
    `);

    const projectRows = await tx.execute<{ id: string; label: string }>(sql`
      SELECT p.id, p.name || ' — ' || c.name AS label
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status <> 'delivered' AND p.archived_at IS NULL
       ORDER BY lower(p.name)
    `);

    return { rows: list.rows, projects: projectRows.rows };
  });

  const mine = rows.filter((r) => r.owner_id === me.id);
  const myDrafts = mine.filter((r) => r.status === 'draft');
  const shared = rows.filter((r) => r.status === 'ready');

  function card(r: Row, showOwner: boolean) {
    return (
      <li key={r.id}>
        <Link
          href={`/prep/${r.id}`}
          className="card block px-5 py-4 transition-shadow hover:shadow-md"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <p className="font-semibold">{r.title}</p>
            <span className={`chip ${r.status === 'ready' ? 'tone-ok' : 'tone-quiet'}`}>
              {r.status === 'ready' ? 'Ready' : 'Draft — only you'}
            </span>
          </div>
          <p className="hint mt-1">
            {PREP_KIND_LABELS[r.kind] ?? r.kind}
            {showOwner ? ` · ${r.owner_name}` : ''}
            {r.project_name ? ` · ${r.project_name}` : ''}
            {Number(r.file_count) > 0 ? ` · ${r.file_count} file(s)` : ''}
            {Number(r.comment_count) > 0 ? ` · ${r.comment_count} note(s)` : ''}
          </p>
          <p className="hint mt-0.5">
            {r.status === 'ready' && r.ready_at
              ? `Shared ${formatDate(r.ready_at)}`
              : `Last touched ${formatDate(r.updated_at)}`}
          </p>
        </Link>
      </li>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Before the camera" title="Prep" />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        Where each of us gathers what a video needs before it is shot. Your drafts
        are yours alone — nobody on the team, management included, can read one
        until you mark it ready. Once you do, everyone can.
      </p>

      <Section title={`Mine — ${mine.length}`}>
        {mine.length === 0 ? (
          <Empty message="Nothing of yours yet — start something below" />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">{mine.map((r) => card(r, false))}</ul>
        )}
        {myDrafts.length > 0 && (
          <p className="hint mt-3">
            {myDrafts.length} draft{myDrafts.length === 1 ? '' : 's'} nobody else can see.
          </p>
        )}
      </Section>

      <Section title={`From the team — ${shared.filter((r) => r.owner_id !== me.id).length}`}>
        {shared.filter((r) => r.owner_id !== me.id).length === 0 ? (
          <Empty message="Nothing shared yet. What the team marks ready appears here." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {shared.filter((r) => r.owner_id !== me.id).map((r) => card(r, true))}
          </ul>
        )}
      </Section>

      <Section title="Start something">
        <NewPrepForm action={createPrepAction} projects={projects} />
      </Section>
    </>
  );
}
