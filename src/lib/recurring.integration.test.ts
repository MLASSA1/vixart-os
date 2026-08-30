import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Fixed charges are a checklist, not a timer.
 *
 * They used to post themselves on their due day. That is a claim that money
 * left the account, made by a calendar rather than by a bank: rent paid late,
 * or skipped that month, still read as paid. Now a charge falls due and waits,
 * and the ledger line is written when someone confirms the money went — with
 * the date and the amount it really was.
 *
 * What has to hold:
 *   - nothing is written until it is confirmed
 *   - confirming twice writes one line, not two
 *   - the amount at payment wins over the amount on the template
 *   - unticking removes the line, so the books never show money that was
 *     never spent
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ recurring integration probe';

describe.skipIf(!HAS_DB)('fixed charges (integration)', () => {
  let db: Client;
  let chargeId = '';

  async function cleanup() {
    await db.query("SET app.bootstrap = 'on'");
    await db.query('DELETE FROM finance_entry WHERE description LIKE $1', [`${MARK}%`]);
    await db.query('DELETE FROM recurring_entry WHERE description = $1', [MARK]);
  }

  async function makeCharge(kind: 'fixed' | 'variable', amount: string, start = '2026-01-01') {
    const r = await db.query<{ id: string }>(
      `INSERT INTO recurring_entry
         (direction, kind, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date, is_active)
       VALUES ('expense', $1, $2, 'loyer', 'virement', $3, 'monthly', 1, $4, true)
       RETURNING id`,
      [kind, amount, MARK, start],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await cleanup();
    chargeId = await makeCharge('fixed', '1150000');
  });

  afterAll(async () => { if (db) { await cleanup(); await db.end(); } });

  it('writes nothing until a month is confirmed', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM finance_entry WHERE recurring_entry_id = $1`, [chargeId]);
    expect(rows).toHaveLength(0);
  });

  it('records the month with the date and amount that actually moved', async () => {
    await db.query(`SELECT app.pay_charge($1, '2026-03', 1150000, '2026-03-04', 'virement')`,
      [chargeId]);

    const { rows } = await db.query<{ amount: string; d: string; period: string; auto: boolean }>(
      `SELECT amount_centimes::text AS amount, entry_date::text AS d,
              period_key AS period, is_automatic AS auto
         FROM finance_entry WHERE recurring_entry_id = $1`, [chargeId]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('1150000');
    expect(rows[0]!.d).toBe('2026-03-04');
    expect(rows[0]!.period).toBe('2026-03');
    // A person confirmed this, so it is not marked as machine-written.
    expect(rows[0]!.auto).toBe(false);
  });

  it('confirming the same month twice still writes one line', async () => {
    await db.query(`SELECT app.pay_charge($1, '2026-03', 1150000, '2026-03-04', 'virement')`,
      [chargeId]);
    await db.query(`SELECT app.pay_charge($1, '2026-03', 9999999, '2026-03-09', 'especes')`,
      [chargeId]);

    const { rows } = await db.query<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n, max(amount_centimes)::text AS amount
         FROM finance_entry WHERE recurring_entry_id = $1 AND period_key = '2026-03'`,
      [chargeId]);
    expect(rows[0]!.n).toBe('1');
    // The first confirmation stands; a second does not overwrite it.
    expect(rows[0]!.amount).toBe('1150000');
  });

  it('takes the amount actually paid, not the one on the template', async () => {
    // Rent with a repair added — 11 500 due, 12 300 paid.
    await db.query(`SELECT app.pay_charge($1, '2026-04', 1230000, '2026-04-02', 'virement')`,
      [chargeId]);
    const { rows } = await db.query<{ amount: string }>(
      `SELECT amount_centimes::text AS amount FROM finance_entry
        WHERE recurring_entry_id = $1 AND period_key = '2026-04'`, [chargeId]);
    expect(rows[0]!.amount).toBe('1230000');
  });

  it('unticking removes the line entirely', async () => {
    await db.query(`SELECT app.unpay_charge($1, '2026-04')`, [chargeId]);
    const { rows } = await db.query(
      `SELECT 1 FROM finance_entry WHERE recurring_entry_id = $1 AND period_key = '2026-04'`,
      [chargeId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a month before the charge existed', async () => {
    const later = await makeCharge('fixed', '50000', '2026-06-01');
    await expect(
      db.query(`SELECT app.pay_charge($1, '2026-05', 50000, '2026-05-01', 'virement')`, [later]),
    ).rejects.toThrow(/only starts/i);
  });

  it('refuses a period that is not a month', async () => {
    await expect(
      db.query(`SELECT app.pay_charge($1, 'March', 1000, '2026-03-01', 'virement')`, [chargeId]),
    ).rejects.toThrow(/looks like 2026-08/i);
  });

  it('refuses a zero or negative amount', async () => {
    await expect(
      db.query(`SELECT app.pay_charge($1, '2026-07', 0, '2026-07-01', 'virement')`, [chargeId]),
    ).rejects.toThrow(/above zero/i);
  });

  it('still refuses a second line for a period inserted directly', async () => {
    await expect(
      db.query(
        `INSERT INTO finance_entry
           (direction, amount_centimes, entry_date, category, payment_method,
            description, recurring_entry_id, period_key, is_automatic)
         VALUES ('expense', 1, current_date, 'loyer', 'virement', $1, $2, '2026-03', false)`,
        [`${MARK} duplicate`, chargeId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('a variable charge takes whatever was paid', async () => {
    const meter = await makeCharge('variable', '80000');
    await db.query(`SELECT app.pay_charge($1, '2026-03', 43700, '2026-03-11', 'especes')`, [meter]);
    await db.query(`SELECT app.pay_charge($1, '2026-04', 121500, '2026-04-10', 'especes')`, [meter]);
    const { rows } = await db.query<{ amounts: string }>(
      `SELECT string_agg(amount_centimes::text, ',' ORDER BY period_key) AS amounts
         FROM finance_entry WHERE recurring_entry_id = $1`, [meter]);
    expect(rows[0]!.amounts).toBe('43700,121500');
  });

  it('refuses to delete a charge that has months paid against it', async () => {
    await expect(
      db.query('DELETE FROM recurring_entry WHERE id = $1', [chargeId]),
    ).rejects.toThrow();
  });
});
