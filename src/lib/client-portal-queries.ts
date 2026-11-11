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
  /** One sentence for the client on what happens next (0086). */
  next_step: string | null;
  /** Files shared with the client on this project (0086). */
  delivered_files: number;
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
           p.next_step,
           (SELECT count(*)::int FROM attachment a
             WHERE a.entity_type = 'project' AND a.entity_id = p.id
               AND a.shared_with_client) AS delivered_files,
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

// ---------------------------------------------------------------------------
// Invoices, quotes and payments (0085)
//
// The client role reads only its own company's ISSUED documents, and only the
// columns printed on them. A query here naming a column outside that grant
// fails rather than returning it — so these lists are written column by
// column, never `d.*`.
// ---------------------------------------------------------------------------

export interface PortalDocument {
  [k: string]: unknown;
  id: string;
  doc_type: 'facture' | 'devis' | 'avoir';
  status: 'emis' | 'paye';
  number: string;
  subject: string | null;
  issue_date: string | null;
  due_date: string | null;
  total_incl_vat: string;
  net_to_collect: string | null;
  /** Everything received on it, reversals netted. Centimes. */
  paid: string;
  /** The account printed on it, frozen at issue (0081). */
  issuer_bank_name: string | null;
  issuer_bank_rib: string | null;
  issuer_bank_iban: string | null;
  issuer_bank_swift: string | null;
}

export async function listPortalDocuments(tx: Tx): Promise<PortalDocument[]> {
  const result = await tx.execute<PortalDocument>(sql`
    SELECT d.id, d.doc_type, d.status, d.number, d.subject,
           d.issue_date::text, d.due_date::text,
           d.total_incl_vat::text, d.net_to_collect::text,
           d.issuer_bank_name, d.issuer_bank_rib, d.issuer_bank_iban, d.issuer_bank_swift,
           coalesce((SELECT sum(p.amount_centimes) FROM document_payment p
                      WHERE p.document_id = d.id), 0)::text AS paid
      FROM document d
     ORDER BY d.issue_date DESC NULLS LAST, d.number DESC
  `);
  return result.rows;
}

export interface PortalPayment {
  [k: string]: unknown;
  id: string;
  document_id: string;
  number: string;
  /** Negative on a reversal. */
  amount_centimes: string;
  method: string;
  paid_on: string;
  is_reversal: boolean;
  reversed: boolean;
}

/**
 * Every payment on their invoices, newest first. A reversed payment stays
 * listed beside its reversal, the same as on our side; the reason we wrote
 * for reversing it is not readable by this role and is not shown.
 */
export async function listPortalPayments(tx: Tx): Promise<PortalPayment[]> {
  const result = await tx.execute<PortalPayment>(sql`
    SELECT p.id, p.document_id, d.number, p.amount_centimes::text,
           p.method, p.paid_on::text,
           (p.reverses_id IS NOT NULL) AS is_reversal,
           EXISTS (SELECT 1 FROM document_payment r WHERE r.reverses_id = p.id) AS reversed
      FROM document_payment p
      JOIN document d ON d.id = p.document_id
     ORDER BY p.paid_on DESC, p.created_at DESC
  `);
  return result.rows;
}

// ---------------------------------------------------------------------------
// One project (0086)
// ---------------------------------------------------------------------------

export interface PortalProjectDetail extends PortalProject {
  project_type: string;
  next_step: string | null;
  next_step_set_at: string | null;
}

export async function findPortalProject(tx: Tx, id: string): Promise<PortalProjectDetail | null> {
  const result = await tx.execute<PortalProjectDetail>(sql`
    SELECT p.id, p.name, p.status, p.description, p.project_type,
           p.start_date::text AS start_date,
           p.due_date::text   AS due_date,
           p.next_step, p.next_step_set_at::text, 0 AS delivered_files,
           pr.done, pr.total, pr.percent, pr.by_hand
      FROM project p
      LEFT JOIN LATERAL app.project_progress(p.id) pr ON true
     WHERE p.id = ${id}
  `);
  return result.rows[0] ?? null;
}

export interface PortalDeliveredFile {
  [k: string]: unknown;
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  caption: string | null;
  shared_at: string;
}

/** Files we chose to share on this project. Nothing else on it is readable. */
export async function listDeliveredFiles(tx: Tx, projectId: string): Promise<PortalDeliveredFile[]> {
  const result = await tx.execute<PortalDeliveredFile>(sql`
    SELECT a.id, a.original_name, a.mime_type, a.size_bytes::text, a.caption,
           a.shared_at::text
      FROM attachment a
     WHERE a.entity_type = 'project' AND a.entity_id = ${projectId}
       AND a.shared_with_client
     ORDER BY a.shared_at DESC
  `);
  return result.rows;
}

// ---------------------------------------------------------------------------
// What is new in the conversation (0087)
// ---------------------------------------------------------------------------

export interface PortalInbox {
  [k: string]: unknown;
  /** Replies from the team since this contact last opened the conversation. */
  unread: number;
  /** When this contact last opened it, before this visit. */
  last_read_at: string | null;
  /** When anybody on the team last opened it. */
  seen_by_team_at: string | null;
}

export async function readPortalInbox(tx: Tx): Promise<PortalInbox> {
  const result = await tx.execute<PortalInbox>(sql`
    SELECT
      (SELECT count(*)::int FROM message m
        WHERE m.author_contact_id IS NULL AND m.withdrawn_at IS NULL
          AND m.created_at > coalesce(
                (SELECT r.last_read_at FROM client_thread_read r
                  WHERE r.contact_id = app.current_client_contact()
                    AND r.thread_id = m.thread_id), '-infinity')) AS unread,
      (SELECT max(r.last_read_at)::text FROM client_thread_read r
        WHERE r.contact_id = app.current_client_contact()) AS last_read_at,
      app.support_seen_by_team_at()::text AS seen_by_team_at
  `);
  return result.rows[0] ?? { unread: 0, last_read_at: null, seen_by_team_at: null };
}

/** Opening the conversation counts as reading it. */
export async function markSupportRead(tx: Tx, threadId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO client_thread_read (contact_id, thread_id, last_read_at)
    VALUES (app.current_client_contact(), ${threadId}, now())
    ON CONFLICT (contact_id, thread_id) DO UPDATE SET last_read_at = now()
  `);
}
