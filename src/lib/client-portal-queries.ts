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
           pr.done, pr.total
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
    SELECT id, body, created_at::text, withdrawn_at::text, author_name,
           coalesce(mine, false) AS mine
      FROM page
     ORDER BY created_at
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
