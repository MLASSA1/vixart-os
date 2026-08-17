import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Recurring costs post themselves, and never twice.
 *
 * The whole design rests on that second half: the nightly job runs on a timer,
 * the app runs it on restart, and an admin can press a button. If any of those
 * could double-post, the accounts would drift with no obvious cause.
 */

const URL = process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!URL) return false;
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = await reachable();
const MARK = 'ZZZ recurring integration probe';

describe.skipIf(!HAS_DB)('recurring finance (integration)', () => {
  let db: Client;

  async function cleanup() {
    await db.query("SET app.bootstrap = 'on'");
    await db.query('DELETE FROM finance_entry WHERE description LIKE $1', [`${MARK}%`]);
    await db.query('DELETE FROM recurring_entry WHERE description = $1', [MARK]);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL });
    await db.connect();
    await db.query("SET app.bootstrap = 'on'");
    await cleanup();
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.end();
  });

  it('catches up every missed period, then stops', async () => {
    await db.query(
      `INSERT INTO recurring_entry
         (direction, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date)
       VALUES ('expense', 600000, 'loyer', 'virement', $1, 'monthly', 5,
               (current_date - interval '6 months')::date)`,
      [MARK],
    );

    const first = await db.query<{ n: number }>('SELECT app.post_due_recurring() AS n');
    expect(first.rows[0]!.n).toBeGreaterThanOrEqual(6);

    // Running it again — nightly job, restart, button — must add nothing.
    for (let i = 0; i < 3; i += 1) {
      const again = await db.query<{ n: number }>('SELECT app.post_due_recurring() AS n');
      expect(again.rows[0]!.n).toBe(0);
    }

    const lines = await db.query<{ lines: string; periods: string }>(
      `SELECT count(*)::text AS lines, count(DISTINCT period_key)::text AS periods
         FROM finance_entry WHERE description LIKE $1`,
      [`${MARK}%`],
    );
    // One line per period, however many times the catch-up ran.
    expect(lines.rows[0]!.lines).toBe(lines.rows[0]!.periods);
  });

  it('refuses a second line for a period even when inserted directly', async () => {
    const { rows } = await db.query<{ id: string; period_key: string }>(
      `SELECT recurring_entry_id AS id, period_key FROM finance_entry
        WHERE description LIKE $1 LIMIT 1`,
      [`${MARK}%`],
    );
    const existing = rows[0]!;

    await expect(
      db.query(
        `INSERT INTO finance_entry
           (direction, amount_centimes, entry_date, category, payment_method,
            description, is_automatic, recurring_entry_id, period_key)
         VALUES ('expense', 600000, current_date, 'loyer', 'virement', $1, true, $2, $3)`,
        [`${MARK} duplicate`, existing.id, existing.period_key],
      ),
    ).rejects.toThrow(/finance_one_line_per_period|duplicate key/i);
  });

  it('does not post a period before it has arrived', async () => {
    await cleanup();
    await db.query(
      `INSERT INTO recurring_entry
         (direction, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date)
       VALUES ('expense', 100000, 'internet', 'virement', $1, 'monthly', 28,
               date_trunc('month', current_date)::date)`,
      [MARK],
    );

    // Ask as if it were the 1st: day 28 has not come round yet.
    const early = await db.query<{ n: number }>(
      `SELECT app.post_due_recurring(date_trunc('month', current_date)::date) AS n`,
    );
    expect(early.rows[0]!.n).toBe(0);

    // And as if it were the 28th, it posts exactly one.
    const due = await db.query<{ n: number }>(
      `SELECT app.post_due_recurring((date_trunc('month', current_date) + interval '27 days')::date) AS n`,
    );
    expect(due.rows[0]!.n).toBe(1);
  });

  it('stops posting once the template is deactivated', async () => {
    await cleanup();
    await db.query(
      `INSERT INTO recurring_entry
         (direction, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date, is_active)
       VALUES ('expense', 100000, 'logiciel', 'carte', $1, 'monthly', 1,
               (current_date - interval '3 months')::date, false)`,
      [MARK],
    );
    const result = await db.query<{ n: number }>('SELECT app.post_due_recurring() AS n');
    expect(result.rows[0]!.n).toBe(0);
  });

  it('refuses to delete a template that has already posted', async () => {
    await cleanup();
    await db.query(
      `INSERT INTO recurring_entry
         (direction, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date)
       VALUES ('expense', 250000, 'loyer', 'virement', $1, 'monthly', 1,
               (current_date - interval '2 months')::date)`,
      [MARK],
    );
    await db.query('SELECT app.post_due_recurring()');

    // Those months' rent really was paid. The record has to survive, so the
    // template is stopped rather than erased.
    await expect(
      db.query('DELETE FROM recurring_entry WHERE description = $1', [MARK]),
    ).rejects.toThrow(/violates foreign key|still referenced/i);

    const lines = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_entry WHERE description LIKE $1`,
      [`${MARK}%`],
    );
    expect(Number(lines.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('allows deleting a template that never posted', async () => {
    await cleanup();
    await db.query(
      `INSERT INTO recurring_entry
         (direction, amount_centimes, category, payment_method, description,
          frequency, day_of_month, start_date)
       VALUES ('expense', 90000, 'logiciel', 'carte', $1, 'monthly', 15,
               (current_date + interval '2 months')::date)`,
      [MARK],
    );
    // Starts in the future, so nothing has posted — a mistyped template can
    // still be removed outright.
    await db.query('DELETE FROM recurring_entry WHERE description = $1', [MARK]);
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM recurring_entry WHERE description = $1',
      [MARK],
    );
    expect(rows[0]!.n).toBe('0');
  });
});
