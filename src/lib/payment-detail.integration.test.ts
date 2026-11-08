import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Where a client pays (0081).
 *
 * One admin-only row, and four columns copied onto each document at issue. The
 * snapshot is the part worth testing hardest: a client who paid last year paid
 * into the account printed on last year's invoice, so changing banks must not
 * rewrite the payment instructions on invoices already in their accounts — or
 * in ours.
 *
 * Everything runs as `vixart_app` with a real identity. The owner role is a
 * superuser and bypasses every policy, so "an admin can read it" proved as
 * owner would prove nothing about whether a member cannot.
 */

const URL = process.env.DATABASE_URL;
const MARK = 'ZZZ payment detail probe';

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const HAS_DB = await reachable();

describe.skipIf(!HAS_DB)('payment_detail (integration)', () => {
  let db: Client;
  let admin = '';
  let moderator = '';
  let member = '';
  let company = '';
  let saved: { bank_name: string | null; rib: string | null;
               iban: string | null; swift: string | null } | null = null;

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    const one = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0]?.id ?? '';
    admin = await one(`SELECT id FROM app_user WHERE role='admin' LIMIT 1`);
    moderator = await one(`SELECT id FROM app_user WHERE role='moderator' LIMIT 1`);
    member = await one(
      `SELECT id FROM app_user WHERE role='member' AND is_assignable
         AND NOT is_service_account LIMIT 1`);
    company = await one(`SELECT id FROM company WHERE relationship='client' LIMIT 1`);
    // Remember the real row so the suite leaves it exactly as it found it.
    saved = (await db.query(`SELECT bank_name, rib, iban, swift FROM payment_detail LIMIT 1`))
      .rows[0] ?? null;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`SET app.bootstrap = 'on'`);
    await db.query(
      `DELETE FROM document_line WHERE document_id IN (SELECT id FROM document WHERE subject = $1)`,
      [MARK]);
    await db.query(`DELETE FROM document WHERE subject = $1`, [MARK]);
    if (saved) {
      await db.query(
        `UPDATE payment_detail SET bank_name=$1, rib=$2, iban=$3, swift=$4`,
        [saved.bank_name, saved.rib, saved.iban, saved.swift]);
    }
    await db.end();
  });

  async function as<T = unknown>(userId: string, role: string, sql: string, params: unknown[] = []) {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE vixart_app');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await db.query(`SELECT set_config('app.user_role', $1, true)`, [role]);
      const out = await db.query<T extends object ? T : never>(sql, params);
      await db.query('COMMIT');
      return out;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  it('is visible to an administrator and to nobody else', async () => {
    const seen = async (id: string, role: string) =>
      Number((await as<{ n: string }>(id, role, `SELECT count(*)::text AS n FROM payment_detail`))
        .rows[0]!.n);

    expect(await seen(admin, 'admin')).toBe(1);
    // Not an error — row level security answers "nothing here", which is why
    // the save action checks how many rows it touched rather than trusting it.
    expect(await seen(moderator, 'moderator')).toBe(0);
    expect(await seen(member, 'member')).toBe(0);
  });

  it('refuses a moderator trying to change it', async () => {
    const out = await as(moderator, 'moderator',
      `UPDATE payment_detail SET bank_name = 'Moderator Bank'`);
    expect(out.rowCount).toBe(0);
  });

  it('holds exactly one row, for ever', async () => {
    await expect(
      db.query(`INSERT INTO payment_detail (bank_name) VALUES ('Second Bank')`),
    ).rejects.toThrow(/payment_detail_one_row|duplicate key/i);
  });

  it('refuses a malformed account', async () => {
    // Each of these is a typo somebody could plausibly make, and each would
    // send a payment somewhere nobody checked.
    await expect(db.query(`UPDATE payment_detail SET rib='00778000012345678901234'`))
      .rejects.toThrow(/rib_shape/);          // 23 digits
    await expect(db.query(`UPDATE payment_detail SET rib='0077800001234567890123４5'`))
      .rejects.toThrow(/rib_shape/);          // a full-width digit
    await expect(db.query(`UPDATE payment_detail SET iban='64007780000123456789012345'`))
      .rejects.toThrow(/iban_shape/);         // no country code
    await expect(db.query(`UPDATE payment_detail SET swift='EXMPMAM'`))
      .rejects.toThrow(/swift_shape/);        // 7 characters
  });

  it('accepts a well-formed one, and allows a partial save', async () => {
    await db.query(
      `UPDATE payment_detail SET bank_name='Example Bank', rib=$1, iban=$2, swift=$3`,
      ['007780000123456789012345', 'MA64007780000123456789012345', 'EXMPMAMC']);
    // The bank name may be known days before the IBAN arrives.
    await expect(db.query(`UPDATE payment_detail SET iban=NULL`)).resolves.toBeTruthy();
    await db.query(`UPDATE payment_detail SET iban='MA64007780000123456789012345'`);
  });

  it('copies the account onto a document at issue, and freezes it', async () => {
    if (!company) return;
    await db.query(`SET app.bootstrap = 'on'`);
    await db.query(
      `UPDATE company SET ice='001234567000089', identifiant_fiscal='45678901',
              registre_commerce='RC 12345 (Agadir)' WHERE id=$1`, [company]);

    const doc = (await as<{ id: string }>(admin, 'admin',
      `INSERT INTO document (doc_type, company_id, created_by_id, subject, vat_rate_bp)
       VALUES ('facture',$1,$2,$3,2000) RETURNING id`, [company, admin, MARK])).rows[0]!.id;
    await as(admin, 'admin',
      `INSERT INTO document_line (document_id,label,unit,unit_price_centimes,quantity_millis,position)
       VALUES ($1,'Brand film','forfait',1000000,1000,1)`, [doc]);
    await as(admin, 'admin', `SELECT app.issue_document($1,'virement',NULL)`, [doc]);

    const row = (await db.query<{ n: string | null; r: string | null; i: string | null; s: string | null }>(
      `SELECT issuer_bank_name AS n, issuer_bank_rib AS r,
              issuer_bank_iban AS i, issuer_bank_swift AS s
         FROM document WHERE id=$1`, [doc])).rows[0]!;
    expect(row.n).toBe('Example Bank');
    expect(row.r).toBe('007780000123456789012345');
    expect(row.s).toBe('EXMPMAMC');

    // Changing banks must not rewrite an invoice already issued.
    await db.query(`UPDATE payment_detail SET bank_name='A Different Bank'`);
    const after = (await db.query<{ n: string | null }>(
      `SELECT issuer_bank_name AS n FROM document WHERE id=$1`, [doc])).rows[0]!;
    expect(after.n).toBe('Example Bank');

    // And the snapshot itself is immutable, like every other issued figure.
    await expect(
      db.query(`UPDATE document SET issuer_bank_rib='000000000000000000000000' WHERE id=$1`, [doc]),
    ).rejects.toThrow(/cannot be modified/i);
  });
});
