import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * An email address identifies at most one client sign-in.
 *
 * Found by using the new account form rather than by reading it: typing an
 * address that already had an account created a second company, a second
 * contact and a second account, and nothing anywhere objected.
 *
 * `contact.email` is not unique, correctly — two people at a client can share a
 * shopfront address, and the same person can appear at two companies over the
 * years. Contacts are a directory. What cannot be ambiguous is a LOGIN, and
 * `app.lookup_client_login` selected by email with `LIMIT 1` and no ORDER BY:
 * with two matching accounts it returned whichever the planner produced, which
 * can change between one query and the next.
 *
 * The consequence is the worst kind, because every layer below it works
 * perfectly: the session would carry the other contact's id, and the boundary
 * would then faithfully show that client's projects and that client's
 * conversation to the wrong person. No policy is broken. The wrong identity was
 * handed out at the door.
 *
 * So: it cannot be created, and if it exists anyway sign-in refuses instead of
 * choosing. Both halves are tested, because either alone leaves a case open.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ one address probe';
const SHARED = 'zzz-shared-address@example.invalid';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('one address, one client sign-in (integration)', () => {
  let db: Client;
  let staffId = '';
  const first = { company: '', contact: '' };
  const second = { company: '', contact: '' };

  const HASH = '$2b$12$notarealhashnotarealhashnotarealhashnotarealhash';

  async function makeCompanyAndContact(label: string, email: string) {
    const company = (await db.query<{ id: string }>(
      `INSERT INTO company (name, status, relationship)
       VALUES ($1,'client','client') RETURNING id`, [`${MARK} ${label}`])).rows[0]!.id;
    const contact = (await db.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name, email)
       VALUES ($1,$2,$3) RETURNING id`,
      [company, `${MARK} ${label} person`, email])).rows[0]!.id;
    return { company, contact };
  }

  async function purge() {
    await db.query("SET app.bootstrap = 'on'");
    await db.query(`DELETE FROM message WHERE body LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM thread WHERE title LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM client_account WHERE contact_id IN
                     (SELECT id FROM contact WHERE full_name LIKE $1)`, [`${MARK}%`]);
    await db.query(`DELETE FROM contact WHERE full_name LIKE $1`, [`${MARK}%`]);
    await db.query(`DELETE FROM company WHERE name LIKE $1`, [`${MARK}%`]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await purge();
    await db.query("SET app.bootstrap = 'on'");
    staffId = (await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE is_active AND NOT is_service_account
        ORDER BY created_at LIMIT 1`)).rows[0]!.id;

    Object.assign(first, await makeCompanyAndContact('first', SHARED));
    // Same address, different company. Perfectly legal as a CONTACT.
    Object.assign(second, await makeCompanyAndContact('second', SHARED));
  });

  afterAll(async () => {
    if (db) { await purge(); await db.end(); }
  });

  it('lets two contacts share an address — they are a directory, not logins', async () => {
    const { rows } = await db.query(
      `SELECT id FROM contact WHERE lower(email) = $1 AND full_name LIKE $2`,
      [SHARED, `${MARK}%`]);
    expect(rows).toHaveLength(2);
  });

  it('opens the first account on that address', async () => {
    await expect(db.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,$2,$3)`, [first.contact, HASH, staffId],
    )).resolves.toBeTruthy();
  });

  it('refuses the second, naming the client that has it', async () => {
    await expect(db.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,$2,$3)`, [second.contact, HASH, staffId],
    )).rejects.toThrow(/already a portal account/i);
  });

  it('refuses it even under bootstrap', async () => {
    // Bootstrap exempts a great deal in this schema, and it must not exempt
    // this: a seed or a restore that quietly created the ambiguity would hand
    // somebody the wrong company at the door.
    await db.query("SET app.bootstrap = 'on'");
    await expect(db.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,$2,$3)`, [second.contact, HASH, staffId],
    )).rejects.toThrow(/already a portal account/i);
  });

  it('refuses an account for a contact with no address at all', async () => {
    const nameless = (await db.query<{ id: string }>(
      `INSERT INTO contact (company_id, full_name) VALUES ($1,$2) RETURNING id`,
      [first.company, `${MARK} no address person`])).rows[0]!.id;
    await expect(db.query(
      `INSERT INTO client_account (contact_id, password_hash, created_by_id)
       VALUES ($1,$2,$3)`, [nameless, HASH, staffId],
    )).rejects.toThrow(/no email address/i);
  });

  it('signs the one account in by its address', async () => {
    const { rows } = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM app.lookup_client_login($1)`, [SHARED]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact_id).toBe(first.contact);
  });

  it('is not fooled by case or by stray spaces', async () => {
    const { rows } = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM app.lookup_client_login($1)`,
      [`  ${SHARED.toUpperCase()}  `]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact_id).toBe(first.contact);
  });

  it('refuses to choose when an address somehow has two accounts', async () => {
    /*
     * The second half of the fix. The trigger above stops this being created,
     * so it is forced here the only way it can now happen — by moving an
     * existing account onto the duplicate contact behind the trigger's back,
     * which is what a restore from before 0068 amounts to.
     */
    await db.query('ALTER TABLE client_account DISABLE TRIGGER client_account_one_per_address');
    try {
      await db.query(
        `INSERT INTO client_account (contact_id, password_hash, created_by_id)
         VALUES ($1,$2,$3)`, [second.contact, HASH, staffId]);

      const { rows } = await db.query(
        `SELECT contact_id FROM app.lookup_client_login($1)`, [SHARED]);
      // Nothing. Not the first, not the second, not an error that says how many
      // there are — a sign-in screen answering differently for "no such
      // account" and "two of them" would tell an outsider which addresses we
      // hold.
      expect(rows, 'sign-in picked one of two accounts on the same address').toHaveLength(0);
    } finally {
      await db.query(
        `DELETE FROM client_account WHERE contact_id = $1`, [second.contact]);
      await db.query('ALTER TABLE client_account ENABLE TRIGGER client_account_one_per_address');
    }
  });

  it('works again once the ambiguity is gone', async () => {
    const { rows } = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM app.lookup_client_login($1)`, [SHARED]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact_id).toBe(first.contact);
  });
});
