/**
 * The two reads chat is made of.
 *
 * Both are needed twice: once by the server component that paints the first
 * frame, and once by the route handler the browser polls. Written out twice
 * they would drift, and the drift would be invisible — the page would be right
 * on load and wrong five seconds later.
 *
 * Each takes the transaction it runs in, so the caller decides the identity and
 * these cannot open one of their own. Nothing here re-checks who may see what:
 * that is `thread_select`, asking the parent record, and a second copy of the
 * rule here would be a second copy free to disagree.
 */

import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/session';

export interface ChannelRow {
  [k: string]: unknown;
  id: string;
  kind: 'general' | 'company' | 'project';
  title: string;
  is_default: boolean;
  unread: number;
  last_at: string | null;
}

export interface MessageRow {
  [k: string]: unknown;
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  editable: boolean;
  file_id: string | null;
  file_name: string | null;
  file_size: string | null;
  file_mime: string | null;
}

/** Every channel this person can open, with what they have not read. */
export async function listChannels(tx: Tx, meId: string): Promise<ChannelRow[]> {
  const result = await tx.execute<ChannelRow>(sql`
    SELECT t.id, t.kind, t.title, t.is_default,
           (SELECT count(*) FROM message m
             WHERE m.thread_id = t.id
               -- Your own messages are never unread, whenever you last looked.
               AND m.author_id <> ${meId}
               AND m.created_at > coalesce(
                 (SELECT r.last_read_at FROM thread_read r
                   WHERE r.thread_id = t.id AND r.user_id = ${meId}),
                 'epoch'::timestamptz))::int AS unread,
           (SELECT max(m.created_at)::text FROM message m WHERE m.thread_id = t.id) AS last_at
      FROM thread t
     ORDER BY lower(t.title)
  `);
  return result.rows;
}

/**
 * A channel's messages, oldest first.
 *
 * `after` fetches the tail for a poll. It matches on `edited_at` as well as
 * `created_at`, so a correction made by somebody else arrives at the open
 * window instead of waiting for a reload — the client merges by id.
 */
export async function listMessages(
  tx: Tx,
  threadId: string,
  meId: string,
  after?: string | null,
): Promise<MessageRow[]> {
  const cutoff = after ?? null;
  const result = await tx.execute<MessageRow>(sql`
    SELECT m.id, m.author_id, m.author_name, m.body,
           m.created_at::text, m.edited_at::text,
           -- Computed by the database, so the button and the trigger that
           -- enforces the window cannot disagree about whether it is open.
           (m.author_id = ${meId} AND m.created_at > now() - interval '15 minutes') AS editable,
           a.id::text         AS file_id,
           a.original_name    AS file_name,
           a.size_bytes::text AS file_size,
           a.mime_type        AS file_mime
      FROM message m
      LEFT JOIN attachment a
        ON a.entity_type = 'message' AND a.entity_id = m.id
     WHERE m.thread_id = ${threadId}
       AND (${cutoff}::timestamptz IS NULL
            OR m.created_at > ${cutoff}::timestamptz
            OR m.edited_at   > ${cutoff}::timestamptz)
     ORDER BY m.created_at
  `);
  return result.rows;
}
