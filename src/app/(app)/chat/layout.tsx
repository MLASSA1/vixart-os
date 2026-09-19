import { sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { withUser } from '@/db/session';
import { listChannels, listDms } from '@/lib/chat-queries';
import { createChannelAction, openDirectMessageAction } from './actions';
import { ChannelList } from './ChannelList';

/**
 * Chat as a workspace rather than a list of pages.
 *
 * The channel list lives here, in the layout, so it is mounted once and stays
 * put while you move between channels — which is the whole difference between
 * a chat application and a forum. It is also why it polls for unread counts:
 * a layout is not re-rendered when only the segment below it changes, so
 * without the poll the counts would be whatever they were when you first
 * opened chat.
 */
export const dynamic = 'force-dynamic';

interface TargetRow {
  [k: string]: unknown;
  id: string;
  name: string;
  kind: 'company' | 'project';
}

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const me = session!.user;
  const canCreate = me.role === 'admin' || me.role === 'moderator';

  const { channels, targets, dms, people } = await withUser(async (tx, user) => {
    const list = await listChannels(tx, user.id);

    // Only fetched for someone who can act on it. A member is not offered a
    // picker they would be refused at, and the refusal is the policy's.
    const rows = canCreate
      ? (
          await tx.execute<TargetRow>(sql`
            -- Wrapped, because a UNION's own ORDER BY may only name output
            -- columns: lower(name) directly on the UNION is a syntax error,
            -- and one that only PostgreSQL can tell you about.
            SELECT id, name, kind FROM (
              SELECT p.id::text AS id, p.name AS name, 'project' AS kind
                FROM project p
               UNION ALL
              SELECT c.id::text, c.name, 'company'
                FROM company c
               WHERE c.status = 'client'
            ) t
             ORDER BY kind, lower(name)
          `)
        ).rows
      : [];

    const dms = await listDms(tx, user.id);

    // Everyone you could open a conversation with. Service accounts are
    // excluded here and refused by a trigger — a DM with something that has no
    // inbox is a conversation held with nothing.
    const people = await tx.execute<{ id: string; full_name: string }>(sql`
      SELECT u.id, u.full_name
        FROM app.team_directory u
       WHERE u.is_active
         AND u.id <> ${user.id}
         AND EXISTS (SELECT 1 FROM app_user a
                      WHERE a.id = u.id AND a.is_assignable AND NOT a.is_service_account)
       ORDER BY u.full_name
    `);

    return { channels: list, targets: rows, dms, people: people.rows };
  });

  return (
    <div className="flex min-h-0 flex-1">
      <ChannelList
        initial={channels}
        canCreate={canCreate}
        createAction={createChannelAction}
        targets={targets.map((t) => ({ id: t.id, name: t.name, kind: t.kind }))}
        dms={dms}
        people={people.map((p) => ({ id: String(p.id), fullName: String(p.full_name) }))}
        openDmAction={openDirectMessageAction}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
