import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { ButtonLink, Field, PageHeader, Section } from '@/components/ui';
import { Attachments } from '@/components/Attachments';
import { Comments, type CommentItem } from '@/components/Comments';
import { withUser } from '@/db/session';
import { listAttachments, uploadAttachmentAction } from '@/lib/attachment-actions';
import { formatDate } from '@/lib/format';
import { addCommentAction, deleteCommentAction } from '../../comments-actions';
import { deletePrepAction, setPrepStatusAction, updatePrepAction } from '../actions';
import { EditPrepForm } from '../PrepForms';
import { PREP_KIND_LABELS } from '@/lib/labels';

export const dynamic = 'force-dynamic';

interface Row {
  [k: string]: unknown;
  id: string; title: string; kind: string; body: string | null; status: string;
  owner_id: string; owner_name: string; owner_title: string | null;
  project_id: string | null; project_name: string | null;
  ready_at: string | null; created_at: string; updated_at: string;
}

/**
 * One piece of preparation.
 *
 * A colleague's draft never reaches this page: the row is invisible to the
 * query, so it 404s exactly as a piece that does not exist would. There is no
 * "you do not have permission" screen, because that sentence tells you
 * something exists.
 */
export default async function PrepDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const me = session!.user;

  const data = await withUser(async (tx) => {
    const r = await tx.execute<Row>(sql`
      SELECT p.id, p.title, p.kind, p.body, p.status, p.owner_id,
             u.full_name AS owner_name, u.job_title AS owner_title,
             p.project_id, pr.name AS project_name,
             p.ready_at::text, p.created_at::text, p.updated_at::text
        FROM prep p
        JOIN app.team_directory u ON u.id = p.owner_id
        LEFT JOIN project pr ON pr.id = p.project_id
       WHERE p.id = ${id}
    `);
    const record = r.rows[0];
    if (!record) return null;

    const comments = await tx.execute<{
      [k: string]: unknown;
      id: string; author_id: string; author_name: string; body: string; created_at: string;
    }>(sql`
      SELECT id, author_id, author_name, body, created_at::text
        FROM comment WHERE entity_type='prep' AND entity_id=${id}
       ORDER BY created_at
    `);

    const projects = await tx.execute<{ id: string; label: string }>(sql`
      SELECT p.id, p.name || ' — ' || c.name AS label
        FROM project p JOIN company c ON c.id = p.company_id
       WHERE p.status <> 'delivered' ORDER BY lower(p.name)
    `);

    return { record, comments: comments.rows, projects: projects.rows };
  });

  if (!data) notFound();
  const { record, comments, projects } = data;

  const isOwner = record.owner_id === me.id;
  const isReady = record.status === 'ready';
  const files = await listAttachments('prep', id);

  return (
    <>
      <PageHeader
        eyebrow={PREP_KIND_LABELS[record.kind] ?? record.kind}
        title={record.title}
        actions={<ButtonLink href="/prep" inverse>Back</ButtonLink>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <span className={`chip ${isReady ? 'tone-ok' : 'tone-quiet'}`}>
          {isReady ? 'Shared with the team' : 'Draft — only you can see this'}
        </span>
        <span className="hint">
          {record.owner_name}
          {record.owner_title ? ` · ${record.owner_title}` : ''}
          {record.project_name ? ` · ${record.project_name}` : ''}
        </span>
      </div>

      {isOwner ? (
        <>
          <Section title="Your notes">
            <EditPrepForm
              action={updatePrepAction.bind(null, record.id)}
              projects={projects}
              current={{
                title: record.title,
                kind: record.kind,
                body: record.body ?? '',
                projectId: record.project_id ?? '',
              }}
            />
          </Section>

          <Section title={isReady ? 'Sharing' : 'Share it'}>
            {isReady ? (
              <div>
                <p className="prose-vixart">
                  The team can read this{record.ready_at ? `, shared ${formatDate(record.ready_at)}` : ''}.
                  You can keep editing it — they see the current version.
                </p>
                <form action={setPrepStatusAction} className="mt-4">
                  <input type="hidden" name="prepId" value={record.id} />
                  <input type="hidden" name="status" value="draft" />
                  <button type="submit" className="btn btn-inverse">
                    Pull it back to a draft
                  </button>
                </form>
                <p className="hint mt-2">
                  It disappears from the team again. Anyone who already read it
                  will remember it — this hides the page, not their memory.
                </p>
              </div>
            ) : (
              <div>
                <p className="prose-vixart">
                  Nobody else can see this yet. Mark it ready when it is worth
                  another pair of eyes — it does not have to be finished, only
                  useful.
                </p>
                <form action={setPrepStatusAction} className="mt-4">
                  <input type="hidden" name="prepId" value={record.id} />
                  <input type="hidden" name="status" value="ready" />
                  <button type="submit" className="btn">Mark ready for the team</button>
                </form>
              </div>
            )}
          </Section>
        </>
      ) : (
        <Section title="Notes">
          {record.body ? (
            <p className="prose-vixart whitespace-pre-wrap">{record.body}</p>
          ) : (
            <p className="hint">No written notes — the files and discussion below carry it.</p>
          )}
          <Field label="Shared" value={record.ready_at ? formatDate(record.ready_at) : '—'} />
          <Field label="Last edited" value={formatDate(record.updated_at)} />
        </Section>
      )}

      {/* References, stills, music, a location photo. Only the owner adds them;
          anyone who can see the prep can open them. */}
      <Section title={`References — ${files.length}`}>
        <Attachments
          action={uploadAttachmentAction.bind(null, 'prep', record.id, `/prep/${record.id}`)}
          items={files.map((f) => ({
            id: f.id,
            originalName: f.originalName,
            mimeType: f.mimeType,
            sizeBytes: String(f.sizeBytes),
            caption: f.caption,
            uploaderName: null,
            createdAt: String(f.createdAt),
          }))}
          revalidate={`/prep/${record.id}`}
        />
      </Section>

      <Section title={`Discussion — ${comments.length}`}>
        {!isReady && isOwner && (
          <p className="hint mb-3">
            While this is a draft these are notes to yourself. Once you share it,
            the team can reply here.
          </p>
        )}
        <Comments
          items={comments as unknown as CommentItem[]}
          addAction={addCommentAction.bind(null, 'prep', record.id, `/prep/${record.id}`)}
          deleteAction={deleteCommentAction.bind(null, `/prep/${record.id}`)}
          currentUserId={me.id}
          canModerate={me.role === 'admin' || me.role === 'moderator'}
        />
      </Section>

      {isOwner && (
        <Section title="Remove">
          <form action={deletePrepAction}>
            <input type="hidden" name="prepId" value={record.id} />
            <button type="submit" className="btn btn-inverse">Delete this preparation</button>
          </form>
          <p className="hint mt-2">Its files and notes go with it.</p>
        </Section>
      )}
    </>
  );
}
