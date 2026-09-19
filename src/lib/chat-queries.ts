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
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  file_id: string | null;
  file_name: string | null;
  file_size: string | null;
  file_mime: string | null;
  file_duration_ms: number | null;
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
     -- Direct messages are threads and deliberately are NOT channels. A DM
     -- somebody is in IS visible to them, so this exclusion is what keeps it
     -- out of the client channel list — which is where a private thing would
     -- otherwise get posted into a project by mistake.
     WHERE t.kind <> 'dm'
     ORDER BY lower(t.title)
  `);
  return result.rows;
}

export interface DmRow {
  [k: string]: unknown;
  id: string;
  /** The other person. A DM has no name of its own. */
  title: string;
  other_id: string;
  unread: number;
  last_at: string | null;
}

/**
 * The conversations this person is part of.
 *
 * No participant filter is written here. `thread_select` admits a DM only to
 * its two participants, so the query cannot return one belonging to anybody
 * else even if it tried — the rule has one home, and a filter here would be a
 * second copy of it free to drift.
 */
export async function listDms(tx: Tx, meId: string): Promise<DmRow[]> {
  const result = await tx.execute<DmRow>(sql`
    SELECT t.id,
           u.full_name AS title,
           u.id        AS other_id,
           (SELECT count(*) FROM message m
             WHERE m.thread_id = t.id
               AND m.author_id <> ${meId}
               AND m.created_at > coalesce(
                 (SELECT r.last_read_at FROM thread_read r
                   WHERE r.thread_id = t.id AND r.user_id = ${meId}),
                 'epoch'::timestamptz))::int AS unread,
           (SELECT max(m.created_at)::text FROM message m WHERE m.thread_id = t.id) AS last_at
      FROM thread t
      JOIN app_user u
        ON u.id = CASE WHEN t.participant_a = ${meId}
                       THEN t.participant_b ELSE t.participant_a END
     WHERE t.kind = 'dm'
     ORDER BY lower(u.full_name)
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
           (m.author_id = ${meId} AND m.created_at > now() - interval '15 minutes'
            AND m.withdrawn_at IS NULL) AS editable,
           m.withdrawn_at::text,
           w.full_name AS withdrawn_by,
           a.id::text         AS file_id,
           a.original_name    AS file_name,
           a.size_bytes::text AS file_size,
           a.mime_type        AS file_mime,
           a.duration_ms      AS file_duration_ms
      FROM message m
      LEFT JOIN app_user w ON w.id = m.withdrawn_by_id
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
