import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * 0059 — what may be deleted, and what must be archived.
 *
 * The rule: delete is for things with nothing behind them. Anything carrying a
 * record — a fiscal document, or a conversation — refuses and says to archive.
 *
 * The dangerous case is the quiet one. `thread.company_id` and
 * `thread.project_id` are ON DELETE CASCADE, so before this migration deleting
 * a client removed its channel and every message in it without a word, while
 * 0056 was busy making sure a SINGLE message could not be made to have never
 * existed.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ archive probe';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('archive or delete (integration)', () => {
  let db: Client;
  let someone = '';

  async function purge() {
    await db.query("SET app.bootstrap = 'on'");
    await db.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM document_line WHERE document_id IN
                     (SELECT id FROM document WHERE subject LIKE $1)`, [`${MARK}%`]);
    await db.query(`DELETE FROM document WHERE subject LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await purge();
    someone = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable LIMIT 1`)).rows[0]!.id;
  });

  afterAll(async () => { if (db) { await purge(); await db.end(); } });

  async function makeCompany(name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [name]);
    return rows[0]!.id;
  }

  it('deletes a client that has nothing behind it', async () => {
    const id = await makeCompany(`${MARK} empty`);
    // Its channel exists (0046 opens one for every client) but carries no
    // messages, so there is no conversation to lose.
    await db.query(`DELETE FROM company WHERE id = $1`, [id]);
    expect((await db.query(`SELECT 1 FROM company WHERE id=$1`, [id])).rows).toHaveLength(0);
  });

  it('refuses to delete a client whose channel has been used', async () => {
    const id = await makeCompany(`${MARK} talked to`);
    const { rows: t } = await db.query<{ id: string }>(
      `SELECT id FROM thread WHERE company_id = $1`, [id]);
    await db.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Someone',$3)`, [t[0]!.id, someone, `${MARK} something said`]);

    await expect(db.query(`DELETE FROM company WHERE id = $1`, [id]))
      .rejects.toThrow(/message\(s\) in this channel.*archive/is);

    // And it is still there, with its conversation.
    expect((await db.query(`SELECT 1 FROM company WHERE id=$1`, [id])).rows).toHaveLength(1);
  });

  it('refuses to delete a client with a quote or invoice, and says how many', async () => {
    const id = await makeCompany(`${MARK} invoiced`);
    await db.query(
      `INSERT INTO document (doc_type, company_id, subject, vat_rate_bp)
       VALUES ('devis',$1,$2,2000)`, [id, `${MARK} a quote`]);

    await expect(db.query(`DELETE FROM company WHERE id = $1`, [id]))
      .rejects.toThrow(/1 quote\(s\) or invoice\(s\).*archive/is);
  });

  it('refuses to delete a project whose channel has been used', async () => {
    const co = await makeCompany(`${MARK} for a project`);
    const { rows: p } = await db.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [co, `${MARK} the project`]);
    const { rows: t } = await db.query<{ id: string }>(
      `SELECT id FROM thread WHERE project_id = $1`, [p[0]!.id]);
    await db.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Someone',$3)`, [t[0]!.id, someone, `${MARK} on the project`]);

    await expect(db.query(`DELETE FROM project WHERE id = $1`, [p[0]!.id]))
      .rejects.toThrow(/message\(s\) in this channel/i);
  });

  it('archives instead, keeping everything', async () => {
    const id = await makeCompany(`${MARK} archived`);
    const { rows: t } = await db.query<{ id: string }>(
      `SELECT id FROM thread WHERE company_id = $1`, [id]);
    await db.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Someone',$3)`, [t[0]!.id, someone, `${MARK} kept`]);

    await db.query(`UPDATE company SET archived_at = now() WHERE id = $1`, [id]);

    const { rows } = await db.query<{ archived_at: string; messages: string }>(
      `SELECT c.archived_at::text,
              (SELECT count(*)::text FROM message m JOIN thread th ON th.id=m.thread_id
                WHERE th.company_id = c.id) AS messages
         FROM company c WHERE c.id = $1`, [id]);
    expect(rows[0]!.archived_at).not.toBeNull();
    expect(rows[0]!.messages).toBe('1');
  });
});
