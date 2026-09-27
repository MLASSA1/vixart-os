import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A person's own profile: theirs to write, everyone's to look at.
 *
 * Amin asked for names, pictures, banners and a description, and for a colleague
 * to be openable. The interesting part is not the feature — it is that a profile
 * is the first thing in this system a MEMBER writes that other people read, so
 * the boundaries run the opposite way from everything else here:
 *
 *   * the read is wide on purpose — a face is for looking at;
 *   * the write is narrow — only your own, and only the things that are yours.
 *     Name and description yes; role, access and email no, because those are the
 *     company's statements about somebody and `app_user_team_rules` (0021)
 *     already refuses them;
 *   * one picture and one banner per person, so replacing one cannot leave the
 *     old row for a join to find;
 *   * and a deleted person takes their images with them, because
 *     `attachment.entity_id` is polymorphic and nothing cascades — which is how
 *     notifications came to outlive their threads.
 */

const URL = process.env.DATABASE_URL;
const APP = process.env.APP_DATABASE_URL;
const MARK = 'ZZZ profile probe';

async function reachable(): Promise<boolean> {
  if (!URL || !APP) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('profiles (integration)', () => {
  let owner: Client;
  let app: Pool;
  let me = '';
  let them = '';
  let admin = '';
  /**
   * The real names, to put back.
   *
   * This test renames a person, because that is the feature. The first version
   * did not restore it, so a seeded colleague was left called "Renamed By
   * Themselves" in the test database — which is not leftover probe data, it is an
   * edit to the team, and it broke a test in another file that reads names.
   */
  const realNames = new Map<string, string>();

  const path = () => `2026/09/${crypto.randomUUID()}.png`;

  async function as<T>(id: string, role: string, work: (q: Runner) => Promise<T>): Promise<T> {
    return drizzle(app).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`);
      return work(tx as unknown as Runner);
    });
  }
  type Runner = { execute: (q: unknown) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

  /**
   * Assert a statement is refused, and by WHICH rule.
   *
   * Drizzle wraps a database error as "Failed query: …" and hangs the real one
   * off `cause`, so a regex against the top-level message matches nothing and
   * `.rejects.toThrow(/…/)` fails while the rule under test is working
   * perfectly. Flattening the chain is what makes the assertion about the
   * constraint rather than about the driver.
   */
  async function refused(run: () => Promise<unknown>, because: RegExp): Promise<void> {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'the statement was allowed').toBeDefined();

    const chain: string[] = [];
    let current: unknown = thrown;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as { message?: string; cause?: unknown; detail?: string };
      if (e.message) chain.push(e.message);
      if (e.detail) chain.push(e.detail);
      current = e.cause;
    }
    const all = chain.join(' | ');
    expect(all, `refused, but not by ${because}`).toMatch(because);
  }

  async function purge() {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `DELETE FROM attachment WHERE entity_type IN ('user_avatar','user_banner')
        AND original_name LIKE $1`, [`${MARK}%`]);
    await owner.query(`UPDATE app_user SET bio = NULL WHERE bio LIKE $1`, [`${MARK}%`]);
    for (const [id, name] of realNames) {
      await owner.query(`UPDATE app_user SET full_name = $2 WHERE id = $1`, [id, name]);
    }
    // Anything an earlier, leakier version of this file left behind.
    await owner.query(
      `UPDATE app_user SET full_name = 'Unnamed' WHERE full_name LIKE 'Renamed By %'`);
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: URL });
    await owner.connect();
    await purge();
    const members = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'member' AND is_active
         AND NOT is_service_account ORDER BY created_at LIMIT 2`)).rows;
    me = members[0]!.id;
    them = members[1]!.id;
    admin = (await owner.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'admin' AND is_active LIMIT 1`)).rows[0]!.id;

    for (const id of [me, them]) {
      const { rows } = await owner.query<{ full_name: string }>(
        `SELECT full_name FROM app_user WHERE id = $1`, [id]);
      realNames.set(id, rows[0]!.full_name);
    }
    app = new Pool({ connectionString: APP, max: 2 });
  });

  afterAll(async () => {
    if (app) await app.end();
    if (owner) { await purge(); await owner.end(); }
  });

  // --- what a person may change about themselves -----------------------------

  it('lets a member rename themselves and write a description', async () => {
    const r = await as(me, 'member', (q) => q.execute(sql`
      UPDATE app_user SET full_name = 'Renamed By Themselves', bio = ${`${MARK} I cut the films.`}
       WHERE id = ${me}
    `));
    expect(r.rowCount).toBe(1);
  });

  it('refuses a description longer than the column allows', async () => {
    await refused(
      () =>
      as(me, 'member', (q) => q.execute(sql`
        UPDATE app_user SET bio = ${`${MARK} ` + 'x'.repeat(700)} WHERE id = ${me}
      `)),
      /app_user_bio_sane|violates check/i,
    );
  });

  it('refuses an empty description rather than storing a blank one', async () => {
    // NULL means "nothing written". An empty string would be a second way to
    // say the same thing, and the page would need two tests for one state.
    await refused(
      () =>
      as(me, 'member', (q) => q.execute(sql`
        UPDATE app_user SET bio = '   ' WHERE id = ${me}
      `)),
      /app_user_bio_sane|violates check/i,
    );
  });

  it('still refuses a member changing their own role or access', async () => {
    // Unchanged by any of this, and the reason no role check was written into
    // the profile action: the database already says it.
    await refused(
      () =>
      as(me, 'member', (q) => q.execute(sql`
        UPDATE app_user SET role = 'admin' WHERE id = ${me}
      `)),
      /your own role/i,
    );
  });

  it('refuses a member renaming somebody else', async () => {
    const r = await as(me, 'member', (q) => q.execute(sql`
      UPDATE app_user SET full_name = 'Renamed By A Colleague' WHERE id = ${them}
    `));
    // Not an error — the row is simply not theirs to see for an update.
    expect(r.rowCount, 'a member renamed a colleague').toBe(0);
  });

  // --- the pictures ----------------------------------------------------------

  it('lets a member set their own picture', async () => {
    await expect(as(me, 'member', (q) => q.execute(sql`
      INSERT INTO attachment
        (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
      VALUES ('user_avatar', ${me}, ${`${MARK} face.png`}, ${path()}, 'image/png', 120, ${me})
    `))).resolves.toBeTruthy();
  });

  it('allows exactly one picture per person', async () => {
    await refused(
      () => as(me, 'member', (q) => q.execute(sql`
        INSERT INTO attachment
          (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
        VALUES ('user_avatar', ${me}, ${`${MARK} second face.png`}, ${path()}, 'image/png', 120, ${me})
      `)),
      /attachment_one_per_person|duplicate key/i,
    );
  });

  it('refuses a picture put on somebody else', async () => {
    await refused(
      () => as(me, 'member', (q) => q.execute(sql`
        INSERT INTO attachment
          (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
        VALUES ('user_avatar', ${them}, ${`${MARK} their face.png`}, ${path()}, 'image/png', 120, ${me})
      `)),
      /row-level security|policy/i,
    );
  });

  it('refuses a picture attributed to somebody else', async () => {
    await refused(
      () => as(me, 'member', (q) => q.execute(sql`
        INSERT INTO attachment
          (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
        VALUES ('user_banner', ${me}, ${`${MARK} borrowed.png`}, ${path()}, 'image/png', 120, ${them})
      `)),
      /row-level security|policy/i,
    );
  });

  it('shows a colleague’s picture to everybody signed in', async () => {
    // The one deliberately wide read in the team space. A face is for looking at.
    const r = await as(them, 'member', (q) => q.execute(sql`
      SELECT id FROM attachment WHERE entity_type = 'user_avatar' AND entity_id = ${me}
    `));
    expect(r.rows, 'a colleague cannot see the picture').toHaveLength(1);
  });

  it('lets a person remove their own, and an admin remove anybody’s', async () => {
    const mine = await as(me, 'member', (q) => q.execute(sql`
      DELETE FROM attachment WHERE entity_type = 'user_avatar' AND entity_id = ${me}
    `));
    expect(mine.rowCount).toBe(1);

    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `INSERT INTO attachment
         (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
       VALUES ('user_avatar',$1,$2,$3,'image/png',120,$1)`,
      [them, `${MARK} theirs.png`, `2026/09/${crypto.randomUUID()}.png`]);

    const byAdmin = await as(admin, 'admin', (q) => q.execute(sql`
      DELETE FROM attachment WHERE entity_type = 'user_avatar' AND entity_id = ${them}
    `));
    expect(byAdmin.rowCount, 'an admin cannot remove a picture').toBe(1);
  });

  it('refuses a member removing a colleague’s picture', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query(
      `INSERT INTO attachment
         (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes, uploaded_by_id)
       VALUES ('user_avatar',$1,$2,$3,'image/png',120,$1)`,
      [them, `${MARK} protected.png`, `2026/09/${crypto.randomUUID()}.png`]);

    const r = await as(me, 'member', (q) => q.execute(sql`
      DELETE FROM attachment WHERE entity_type = 'user_avatar' AND entity_id = ${them}
    `));
    expect(r.rowCount, 'a member deleted a colleague’s picture').toBe(0);
  });

  // --- the directory ---------------------------------------------------------

  it('tells a page whether somebody has a picture, without the id', async () => {
    /*
     * `has_avatar` rather than the attachment id, because the interface asks the
     * avatar route by PERSON — one url, cacheable, and no query anywhere has to
     * carry an attachment id around in order to draw a face.
     */
    const r = await as(me, 'member', (q) => q.execute(sql`
      SELECT full_name, bio, has_avatar, has_banner
        FROM app.team_directory WHERE id = ${them}
    `));
    const row = r.rows[0]!;
    expect(row).toHaveProperty('has_avatar');
    expect(row).toHaveProperty('has_banner');
    expect(row).toHaveProperty('bio');
    expect(row.has_avatar, 'has_avatar is not tracking the attachment rows').toBe(true);
  });

  it('takes a deleted person’s images with them', async () => {
    await owner.query("SET app.bootstrap = 'on'");
    const ghost = (await owner.query<{ id: string }>(
      `INSERT INTO app_user (full_name, email, role, password_hash, is_active)
       VALUES ($1,$2,'member','$2b$12$notarealhashnotarealhashnotarealhashnotarealhash',true)
       RETURNING id`,
      [`${MARK} ghost`, 'zzz-profile-ghost@example.invalid'])).rows[0]!.id;
    await owner.query(
      `INSERT INTO attachment
         (entity_type, entity_id, original_name, stored_path, mime_type, size_bytes)
       VALUES ('user_avatar',$1,$2,$3,'image/png',120)`,
      [ghost, `${MARK} ghost face.png`, `2026/09/${crypto.randomUUID()}.png`]);

    await owner.query(`DELETE FROM app_user WHERE id = $1`, [ghost]);

    const { rows } = await owner.query(
      `SELECT id FROM attachment WHERE entity_type = 'user_avatar' AND entity_id = $1`, [ghost]);
    expect(rows, 'a deleted person left their picture behind').toHaveLength(0);
  });
});

/**
 * The avatar route hands over rather than serving.
 *
 * Checked statically, because the mistake it guards against was invisible
 * locally and fatal in production: `NextResponse.redirect` demands an absolute
 * url, so `new URL('/api/files/…', request.url)` looked right and resolved to
 * the CONTAINER's own listen address — http://0.0.0.0:3000, reachable from
 * inside the container and nowhere else. Every face in the application would
 * have been a broken image, and only once deployed.
 */
describe('the avatar route', () => {
  const source = () =>
    readFileSync(join(process.cwd(), 'src/app/api/avatar/[id]/route.ts'), 'utf8');

  it('redirects to the one place that serves files', () => {
    // Not a second implementation of file serving. There is exactly one piece of
    // code that decides the disposition, the sandbox headers and the cache rule,
    // and a copy here would be the one that drifts.
    expect(source()).toContain('/api/files/');
    expect(source(), 'the avatar route streams bytes itself').not.toContain('createReadStream');
  });

  it('never builds an absolute redirect out of the request host', () => {
    const text = source();
    expect(text).toContain("Location: `/api/files/${fileId}`");
    expect(
      text,
      'an absolute redirect resolves to the container address behind nginx',
    ).not.toContain('NextResponse.redirect(');
  });

  it('caches the miss as well as the hit', () => {
    // Most people have no picture for a while. Without a cached 404 every
    // message in every channel costs a request that fails.
    const text = source();
    const misses = [...text.matchAll(/status: 404,\s*\n\s*headers: \{ 'Cache-Control'/g)];
    expect(misses.length, 'the 404 is not cached').toBeGreaterThan(0);
  });
});
