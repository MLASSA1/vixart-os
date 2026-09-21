import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  findSupportThread,
  listPortalMessages,
  listPortalProjects,
  listPortalServices,
  listPortalSystems,
  findPortalSystem,
} from './client-portal-queries';
import type { Tx } from '@/db/session';

/**
 * What the portal actually shows a client.
 *
 * `client-boundary.integration.test.ts` proves what a client CANNOT reach, one
 * refusal at a time. This is the other half: that the queries the portal runs
 * return the right client's things — and, just as important, that they return
 * only those things when there is more than one client on the books. A portal
 * tested against a database with one company in it proves nothing at all,
 * because every query returns the right answer by accident.
 *
 * So there are two clients here, and every assertion is made from inside one
 * of them.
 */

const URL = process.env.DATABASE_URL;
const CLIENT = process.env.CLIENT_DATABASE_URL;
const MARK = 'ZZZ portal probe';

async function reachable(): Promise<boolean> {
  if (!URL || !CLIENT) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('the client portal (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let staffId = '';

  const mine = { company: '', contact: '', project: '', thread: '' };
  const theirs = { company: '', contact: '', project: '', thread: '' };

  /** Runs a portal query as one client, exactly as `withClient` does. */
  async function asClient<T>(contactId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', ${contactId}, true)`);
      return work(tx as unknown as Tx);
    });
  }

  async function makeClient(name: string, target: typeof mine, doneOf: number) {
    target.company = (await owner.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship) VALUES ($1,'client','client') RETURNING id`,
      [`${MARK} ${name}`])).rows[0]!.id;
    target.contact = (await owner.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [target.company, `${MARK} ${name} person`, `zzz-portal-${name}@example.invalid`])).rows[0]!.id;
    await owner.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,'$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',$2)`,
      [target.contact, staffId]);
    target.project = (await owner.query<{ id: string }>(
      `INSERT INTO project (company_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
      [target.company, `${MARK} ${name} project`])).rows[0]!.id;
    target.thread = (await owner.query<{ id: string }>(
      `INSERT INTO thread (kind, title, company_id, created_by_id)
       VALUES ('support',$1,$2,$3) RETURNING id`,
      [`${MARK} ${name} support`, target.company, staffId])).rows[0]!.id;

    /*
     * Five steps, `doneOf` of them finished — created as `todo` and then
     * completed, because that is the only way a task can become completed.
     * A trigger refuses to let one be INSERTED already done: completion is a
     * sign-off, and a sign-off is something that happens to work that exists.
     * Inserting the end state directly would have tested a row the
     * application can never produce.
     */
    for (let i = 1; i <= 5; i += 1) {
      await owner.query(
        `INSERT INTO task (project_id, title, status, priority, assignee_id, created_by_id)
         VALUES ($1,$2,'todo','normal',$3,$3)`,
        [target.project, `${MARK} ${name} step ${i}`, staffId]);
    }
    await owner.query(
      `UPDATE task SET status='completed', completed_by_id=$2, completed_at=now()
        WHERE project_id=$1 AND title LIKE $3
        AND title = ANY($4)`,
      [target.project, staffId, `${MARK}%`,
       Array.from({ length: doneOf }, (_, i) => `${MARK} ${name} step ${i + 1}`)]);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM notification WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM task WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM client_account WHERE contact_id IN
                        (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await owner.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM project WHERE name LIKE $1`, [`${MARK}%`]);
    await owner.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    await owner.query("SET app.bootstrap = 'on'");

    staffId = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND is_assignable
         AND NOT is_service_account ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    await makeClient('mine', mine, 3);
    await makeClient('theirs', theirs, 1);

    await owner.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Staff',$3)`, [mine.thread, staffId, `${MARK} said to mine`]);
    await owner.query(
      `INSERT INTO message (thread_id, author_id, author_name, body)
       VALUES ($1,$2,'Staff',$3)`, [theirs.thread, staffId, `${MARK} said to theirs`]);

    pool = new Pool({ connectionString: CLIENT, max: 2 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (owner) { await purge(); await owner.end(); }
  });

  it('shows a client their own projects, with progress', async () => {
    const projects = await asClient(mine.contact, (tx) => listPortalProjects(tx));
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(mine.project);
    expect(Number(projects[0]!.done)).toBe(3);
    expect(Number(projects[0]!.total)).toBe(5);
  });

  it('gives each client their own progress, not the other one’s', async () => {
    // The check that a single-client database cannot make: 3 of 5 and 1 of 5
    // have to come back to different people.
    const ours = await asClient(mine.contact, (tx) => listPortalProjects(tx));
    const yours = await asClient(theirs.contact, (tx) => listPortalProjects(tx));

    expect(ours.map((p) => p.id)).toEqual([mine.project]);
    expect(yours.map((p) => p.id)).toEqual([theirs.project]);
    expect(Number(ours[0]!.done)).toBe(3);
    expect(Number(yours[0]!.done)).toBe(1);
  });

  it('never returns a task title, only the count', async () => {
    // Task titles are written by the team for the team. The progress figure is
    // the whole of what crosses the boundary.
    const projects = await asClient(mine.contact, (tx) => listPortalProjects(tx));
    const text = JSON.stringify(projects);
    expect(text).not.toContain('step 1');
    expect(text).not.toContain(`${MARK} mine step`);
  });

  it('refuses to count a project belonging to somebody else', async () => {
    // app.project_progress is SECURITY DEFINER and takes an id, which is a way
    // to ask questions about rows you were never shown — unless it checks.
    const { rows } = await drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', ${mine.contact}, true)`);
      return tx.execute<{ done: number; total: number }>(
        sql`SELECT * FROM app.project_progress(${theirs.project}::uuid)`,
      );
    });
    // Zeros rather than an error: a refusal that looks different from an empty
    // project is itself an answer about a project you may not see.
    expect(Number(rows[0]!.total)).toBe(0);
    expect(Number(rows[0]!.done)).toBe(0);
  });

  it('finds one support thread — its own', async () => {
    expect(await asClient(mine.contact, (tx) => findSupportThread(tx))).toBe(mine.thread);
    expect(await asClient(theirs.contact, (tx) => findSupportThread(tx))).toBe(theirs.thread);
  });

  it('reads only its own conversation', async () => {
    const ours = await asClient(mine.contact, (tx) => listPortalMessages(tx));
    expect(ours.map((m) => m.body)).toEqual([`${MARK} said to mine`]);

    const yours = await asClient(theirs.contact, (tx) => listPortalMessages(tx));
    expect(yours.map((m) => m.body)).toEqual([`${MARK} said to theirs`]);
  });

  it('marks who wrote what', async () => {
    await owner.query(
      `INSERT INTO message (thread_id, author_contact_id, author_name, body)
       VALUES ($1,$2,'Client',$3)`, [mine.thread, mine.contact, `${MARK} from the client`]);

    const messages = await asClient(mine.contact, (tx) => listPortalMessages(tx));
    const fromUs = messages.find((m) => m.body === `${MARK} said to mine`);
    const fromThem = messages.find((m) => m.body === `${MARK} from the client`);

    expect(fromUs!.mine).toBe(false);
    expect(fromThem!.mine).toBe(true);
  });

  it('shows the same service catalogue to everybody, and only active entries', async () => {
    // Nothing here belongs to one client, so this one is about `is_active`.
    await owner.query(
      `INSERT INTO service (name, pillar, unit, is_active)
       VALUES ($1,'cinematic_production','jour',false)`, [`${MARK} retired service`]);

    const services = await asClient(mine.contact, (tx) => listPortalServices(tx));
    expect(services.map((s) => s.name)).not.toContain(`${MARK} retired service`);

    await owner.query(`DELETE FROM service WHERE name = $1`, [`${MARK} retired service`]);
  });

  it('shows the same twenty-five systems to every client', async () => {
    // The public catalogue. Unlike everything else in this file it is NOT
    // scoped to a company — both clients must see all of it, and a portal that
    // filtered it by company would show an empty page to everybody.
    const ours = await asClient(mine.contact, (tx) => listPortalSystems(tx));
    const yours = await asClient(theirs.contact, (tx) => listPortalSystems(tx));

    expect(ours.length).toBeGreaterThanOrEqual(20);
    expect(ours.map((s) => s.slug)).toEqual(yours.map((s) => s.slug));

    const families = new Set(ours.map((s) => s.family));
    expect(families).toEqual(new Set(['Growth', 'Engineering', 'Production', 'Design']));
  });

  it('carries the four sections the website states', async () => {
    const system = await asClient(mine.contact, (tx) =>
      findPortalSystem(tx, 'brand-film-system'));

    expect(system).not.toBeNull();
    // The exact words from visionxart.com, which is the point of the feature:
    // a client reading this should be reading what they read on the site.
    expect(system!.name).toBe('Brand Film System™');
    expect(system!.family).toBe('Production');
    expect(system!.what_it_fixes).toContain('explained every time');
    expect(system!.what_it_is).toContain('Directed, shot and edited in-house');
    expect(system!.what_you_get).toContain('Direction and script');
    expect(system!.who_it_is_for).toContain('only works when a person is there');
  });

  it('hides a system that has been retired', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(`UPDATE growth_system SET is_active=false WHERE slug='packaging-system'`);
    try {
      const shown = await asClient(mine.contact, (tx) => listPortalSystems(tx));
      expect(shown.map((s) => s.slug)).not.toContain('packaging-system');
    } finally {
      await owner.query("SET app.bootstrap = 'on'");
      await owner.query(`UPDATE growth_system SET is_active=true WHERE slug='packaging-system'`);
    }
  });

  it('will not let a client edit the catalogue', async () => {
    // Read-only, by grant. The client role has SELECT on growth_system and
    // nothing else, so this fails before any policy is consulted.
    //
    // Asserted on the raw connection rather than through drizzle, which wraps
    // the driver's message in "Failed query: …" — the assertion would then be
    // about drizzle's error formatting rather than about the refusal.
    const raw = await pool.connect();
    try {
      await raw.query(`SELECT set_config('app.client_contact_id',$1,false)`, [mine.contact]);
      await expect(
        raw.query(`UPDATE growth_system SET name = 'mine now'`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      raw.release();
    }
  });

  it('shows nothing to a session with no contact set', async () => {
    const projects = await drizzle(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.client_contact_id', '', true)`);
      return listPortalProjects(tx as unknown as Tx);
    });
    expect(projects).toEqual([]);
  });
});
