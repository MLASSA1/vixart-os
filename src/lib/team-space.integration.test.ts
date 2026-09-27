import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

/**
 * What a member cannot reach.
 *
 * Amin asked for this twice in one message: everybody except him and Mohamed
 * Amine loses the client list, the leads, the projects board, the dashboard, the
 * money, the quotes and invoices and the retainers, and keeps their own work.
 *
 * The pages are closed by the `(management)` route group, which is checked
 * statically in `team-space-guards.test.ts`. This file is the layer underneath:
 * what the member's own session can READ, asked of the database through the
 * application role with a member's identity set. A page that forgets its guard
 * still gets nothing.
 *
 * Written as refusals, like the client boundary, and for the same reason: an
 * application that shows a member their tasks looks identical whether or not it
 * also lets them read every invoice.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ team space probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('the team space (integration)', () => {
  let owner: Client;
  let app: Pool;
  let memberId = '';
  let moderatorId = '';
  let company = '';
  let project = '';
  let taskId = '';

  /** Runs as one person, the way `withUser` does. */
  async function as<T>(id: string, role: string, work: (tx: never) => Promise<T>): Promise<T> {
    return drizzle(app).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`);
      return work(tx as never);
    });
  }

  /** Whether a member can read anything at all from a table. */
  async function memberCanRead(table: string): Promise<boolean> {
    try {
      const r = await as(memberId, 'member', (tx) =>
        (tx as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> })
          .execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`)));
      return r.rows.length > 0;
    } catch (error) {
      if (/permission denied/i.test(String(error))) return false;
      throw error;
    }
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM interaction WHERE company_id IN
                        (SELECT id FROM company WHERE name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    memberId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' AND is_active
         AND NOT is_service_account ORDER BY created_at LIMIT 1`)).rows[0]!.id;
    moderatorId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role IN ('admin','moderator') AND is_active
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} co`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO contact (company_id, full_name, email, phone)
       VALUES ($1,$2,'zzz-teamspace@example.invalid','+212600000000')`,
      [company, `${MARK} their person`]);
    project = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status)
       VALUES ($1,$2,'active') RETURNING id`, [company, `${MARK} project`])).rows[0]!.id;
    taskId = (await owner.query<{ id: string }>(
      `INSERT INTO task (project_id, title, status, priority, assignee_id, created_by_id)
       VALUES ($1,$2,'todo','normal',$3,$4) RETURNING id`,
      [project, `${MARK} their task`, memberId, moderatorId])).rows[0]!.id;

    app = new Pool({ connectionString: APP, max: 2 });
  });

  afterAll(async () => {
    if (app) await app.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('closes the commercial tables to a member', async () => {
    const closed: Record<string, boolean> = {};
    for (const table of ['contact', 'deal', 'retainer', 'document', 'finance_entry']) {
      closed[table] = !(await memberCanRead(table));
    }
    expect(
      Object.entries(closed).filter(([, ok]) => !ok).map(([t]) => t),
      '\nA member can read these:\n  ' +
        Object.entries(closed).filter(([, ok]) => !ok).map(([t]) => t).join(', ') +
        '\nThese are the company’s commercial business.\n',
    ).toEqual([]);
  });

  it('opens them to a moderator, so the refusal is about the role', async () => {
    // Without this the test above would pass on a database where the tables are
    // simply empty, which proves nothing whatsoever.
    const seen = await as(moderatorId, 'moderator', (tx) =>
      (tx as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> })
        .execute(sql`SELECT id FROM contact WHERE full_name LIKE ${`${MARK}%`}`));
    expect(seen.rows).toHaveLength(1);
  });

  it('still lets a member read the project and client their own work is for', async () => {
    /*
     * The deliberate exception, and the reason `company` and `project` were left
     * alone in 0069. A task is a title with no meaning if the person doing it
     * cannot see which job it belongs to.
     */
    const seen = await as(memberId, 'member', (tx) =>
      (tx as unknown as { execute: (q: unknown) => Promise<{ rows: { name: string; client: string }[] }> })
        .execute(sql`
          SELECT p.name, c.name AS client
            FROM task t
            JOIN project p ON p.id = t.project_id
            JOIN company c ON c.id = p.company_id
           WHERE t.id = ${taskId}
        `));
    expect(seen.rows[0]?.name).toBe(`${MARK} project`);
    expect(seen.rows[0]?.client).toBe(`${MARK} co`);
  });

});
