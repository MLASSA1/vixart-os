import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/session';

/**
 * Everything the portal reads.
 *
 * None of these say "where company = mine". They do not have to, and that is
 * the point: the connection they run on is the client role, whose policies
 * admit only their own company's rows (migration 0064). A filter written here
 * as well would be a second copy of the rule, free to drift from the first —
 * and the copy that drifts is always the one nobody tests.
 *
 * Put another way: if a query in this file is wrong, it returns too little.
 * It cannot return somebody else's client.
 */

export interface PortalProject {
  [k: string]: unknown;
  id: string;
  name: string;
  status: string;
  description: string | null;
  start_date: string | null;
  due_date: string | null;
  /** Tasks finished, and tasks in total. The progress, without the detail. */
  done: number;
  total: number;
  /**
   * The figure to show, and the only one that should be shown.
   *
   * The task count is honest and is often wrong for the reader: a project the
   * team runs out of a shared document has no tasks, so a client watching a
   * film being made was shown a bar at zero. `percent` is the hand-set
   * override when Amin or Mohamed Amine has set one and the task count
   * otherwise, decided inside `app.project_progress` so this page and the
   * internal one cannot come to different answers.
   */
  percent: number;
  /**
   * Whether the figure was set by a person rather than counted.
   *
   * Never shown to the client — it decides whether the STEP COUNT is shown
   * beside the bar. Printing "70%" next to "1 of 2 steps done" invites the
   * reader to do the arithmetic, get 50, and conclude one of the two numbers is
   * a lie. One of them is simply not what the bar means.
   */
  by_hand: boolean;
}

/**
 * The client's projects, with progress.
 *
 * WHAT THE PROGRESS IS MADE OF, AND WHAT IT LEAVES OUT.
 *
 * A count of completed tasks against the total, and nothing else. The task
 * TITLES are not here and must not be: they are written by the team for the
 * team, they name people, they say things like "redo, client hated it", and
 * they are the reason `task` is not in the client role's grants at all. The
 * count is aggregated inside the database by a definer function, so the
 * portal never holds the rows it was computed from.
 */
export async function listPortalProjects(tx: Tx): Promise<PortalProject[]> {
  const result = await tx.execute<PortalProject>(sql`
    SELECT p.id, p.name, p.status, p.description,
           p.start_date::text AS start_date,
           p.due_date::text   AS due_date,
           pr.done, pr.total, pr.percent, pr.by_hand
      FROM project p
      -- LATERAL rather than calling the function twice in the select list,
      -- which is two scans of the task table per project for one pair of numbers.
      LEFT JOIN LATERAL app.project_progress(p.id) pr ON true
     ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1
                            WHEN 'on_hold' THEN 2 ELSE 3 END,
              p.due_date NULLS LAST, lower(p.name)
  `);
  return result.rows;
}

export interface PortalMessage {
  [k: string]: unknown;
  id: string;
  body: string;
  created_at: string;
  withdrawn_at: string | null;
  /** Written by us, or by them. Drives which side of the conversation it is. */
  mine: boolean;
  author_name: string;
  /**
   * What was attached, if anything.
   *
   * The conversation had none of this: a client could be sent a photograph and
   * would see a message with no picture in it, which is worse than not being
   * sent one. The bytes are never here — only the id, which the authenticated
   * file route resolves under this client's own policies.
   */
  file_id: string | null;
  file_name: string | null;
  file_size: string | null;
  file_mime: string | null;
  file_duration_ms: number | null;
}

/**
 * The support conversation, newest page last.
 *
 * Bounded like every other message list in this application: a conversation
 * that has run for two years is not something to render in full on a phone.
 */
export async function listPortalMessages(
  tx: Tx,
  options?: { before?: string | null; limit?: number },
): Promise<PortalMessage[]> {
  const before = options?.before ?? null;
  const limit = Math.min(options?.limit ?? 50, 200);

  const result = await tx.execute<PortalMessage>(sql`
    WITH page AS (
      SELECT m.id, m.body, m.created_at, m.withdrawn_at, m.author_name,
             (m.author_contact_id = app.current_client_contact()) AS mine
        FROM message m
       WHERE (${before}::timestamptz IS NULL OR m.created_at < ${before}::timestamptz)
       ORDER BY m.created_at DESC
       LIMIT ${limit}
    )
    SELECT p.id, p.body, p.created_at::text, p.withdrawn_at::text, p.author_name,
           coalesce(p.mine, false) AS mine,
           a.id::text         AS file_id,
           a.original_name    AS file_name,
           a.size_bytes::text AS file_size,
           a.mime_type        AS file_mime,
           a.duration_ms      AS file_duration_ms
      FROM page p
      -- One file per message, the same as the team side. LEFT, because most
      -- messages are words.
      LEFT JOIN attachment a
        ON a.entity_type = 'message' AND a.entity_id = p.id
     ORDER BY p.created_at
  `);
  return result.rows;
}

/** The one thread they are allowed to see. There is exactly one. */
export async function findSupportThread(tx: Tx): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`
    SELECT id FROM thread WHERE kind = 'support' LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
}

export interface PortalSystem {
  [k: string]: unknown;
  id: string;
  slug: string;
  name: string;
  family: string;
  position: number;
  what_it_fixes: string;
  what_it_is: string;
  what_you_get: string[];
  who_it_is_for: string;
  image: string | null;
}

/**
 * The twenty-five systems, as visionxart.com states them.
 *
 * Nothing here belongs to one client — it is the public catalogue — so unlike
 * every other query in this file there is no company to scope by. The only
 * rule the policy applies is that a retired system stops being shown.
 */
export async function listPortalSystems(tx: Tx): Promise<PortalSystem[]> {
  const result = await tx.execute<PortalSystem>(sql`
    SELECT id, slug, name, family, position,
           what_it_fixes, what_it_is, what_you_get, who_it_is_for, image
      FROM growth_system
     ORDER BY CASE family WHEN 'Growth' THEN 0 WHEN 'Engineering' THEN 1
                          WHEN 'Production' THEN 2 ELSE 3 END, position
  `);
  return result.rows;
}

/** One system, by the slug the website uses. */
export async function findPortalSystem(
  tx: Tx,
  slug: string,
): Promise<PortalSystem | null> {
  const result = await tx.execute<PortalSystem>(sql`
    SELECT id, slug, name, family, position,
           what_it_fixes, what_it_is, what_you_get, who_it_is_for, image
      FROM growth_system WHERE slug = ${slug}
  `);
  return result.rows[0] ?? null;
}

export interface PortalService {
  [k: string]: unknown;
  id: string;
  name: string;
  pillar: string;
  unit: string;
  description: string | null;
}

/** What VIXART does. The same catalogue the team quotes from. */
export async function listPortalServices(tx: Tx): Promise<PortalService[]> {
  const result = await tx.execute<PortalService>(sql`
    SELECT id, name, pillar, unit, description
      FROM service
     ORDER BY pillar, lower(name)
  `);
  return result.rows;
}
