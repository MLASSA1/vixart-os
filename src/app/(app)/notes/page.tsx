import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { Empty, PageHeader, Section } from '@/components/ui';
import { withUser } from '@/db/session';
import { since } from '@/lib/format';
import { deleteNoteAction, saveNoteAction } from './actions';
import { NoteForm } from './NoteForm';

export const dynamic = 'force-dynamic';

interface Note {
  [k: string]: unknown;
  id: string; title: string; body: string; updated_at: string;
}

/**
 * Notes — a private scratchpad.
 *
 * Where somebody drafts a script idea or a thought about a client before it is
 * ready to be said out loud. Not where decisions go: a decision belongs in a
 * channel where the people it affects can read it, and the page says so.
 */
export default async function NotesPage() {
  const session = await auth();
  const me = session!.user;

  const notes = await withUser(async (tx) => {
    // No author filter: the policy is the filter, and writing a second one
    // here would be a copy of the rule free to drift from it.
    const result = await tx.execute<Note>(sql`
      SELECT id, title, body, updated_at::text
        FROM private_note ORDER BY updated_at DESC
    `);
    return result.rows;
  });

  return (
    <>
      <PageHeader eyebrow={me.name ?? 'Me'} title="Notes" />

      <p className="prose-vixart" style={{ opacity: 0.7 }}>
        Yours alone. Nobody else can read these — not a moderator, not an
        administrator. It is somewhere to think before you are ready to say
        something; anything the team needs to act on belongs in a channel or a
        task, where they can see it.
      </p>

      <Section title="New note">
        <NoteForm action={saveNoteAction} />
      </Section>

      <Section title={`Written — ${notes.length}`}>
        {notes.length === 0 ? (
          <Empty message="Nothing yet." />
        ) : (
          <ul className="space-y-6">
            {notes.map((n) => (
              <li key={n.id} className="card px-5 py-4">
                <NoteForm action={saveNoteAction} note={{ id: n.id, title: n.title, body: n.body }} />
                <div className="mt-2 flex items-center gap-4">
                  <span className="hint">Edited {since(n.updated_at)}</span>
                  <form action={deleteNoteAction} className="ml-auto">
                    <input type="hidden" name="noteId" value={n.id} />
                    <button
                      type="submit"
                      className="cursor-pointer text-[11.5px] font-medium text-void/45 hover:text-void hover:underline"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
