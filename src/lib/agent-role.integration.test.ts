import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The wall around the agent, demonstrated rather than assumed.
 *
 * The brief's premise is that a prompt is a suggestion and a grant is a wall.
 * These tests connect as `vixart_agent` itself — not as the app pretending to
 * be it — so what they prove is a property of the connection. Whatever the
 * model decides to do, this is the ceiling.
 *
 * Assertions are on DATA wherever a refusal could come from either RLS or a
 * grant: RLS filters an UPDATE to zero rows and raises nothing at all, so
 * "expect it to throw" would pass for the wrong reason, or fail while the data
 * is in fact safe.
 */

const OWNER = process.env.DATABASE_URL;
const AGENT = process.env.AGENT_DATABASE_URL;

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const HAS_DB = (await reachable(OWNER)) && (await reachable(AGENT));
const MARK = 'ZZZ agent-role probe';

describe.skipIf(!HAS_DB)('agent role (integration)', () => {
  let owner: Client;
  let agent: Client;
  let companyId: string;
  let draftId: string;

  /** A real agent connection, in an agent session. */
  async function asAgent(): Promise<Client> {
    const c = new Client({ connectionString: AGENT });
    await c.connect();
    await c.query("SELECT set_config('app.user_role','agent',false)");
    return c;
  }

  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    const { rows } = await owner.query<{ id: string }>('SELECT id FROM company LIMIT 1');
    companyId = rows[0]!.id;
    agent = await asAgent();
  });

  afterAll(async () => {
    if (agent) await agent.end();
    if (owner) {
      await owner.query("SET app.bootstrap = 'on'");
      await owner.query('DELETE FROM document_line WHERE document_id IN (SELECT id FROM document WHERE subject = $1)', [MARK]);
      await owner.query('DELETE FROM finance_entry WHERE description = $1', [MARK]);
      await owner.query('ALTER TABLE document DISABLE TRIGGER document_immutable');
      await owner.query('DELETE FROM document WHERE subject = $1', [MARK]);
      await owner.query('ALTER TABLE document ENABLE TRIGGER document_immutable');
      await owner.query(`UPDATE document_counter c SET last_seq = coalesce(
        (SELECT max(d.number_seq) FROM document d
          WHERE d.doc_type = c.doc_type AND d.number_year = c.year), 0)`);
      await owner.end();
    }
  });

  // --- What it is supposed to be able to do --------------------------------

  it('can read the tables it reports on', async () => {
    for (const table of [
      'company', 'finance_entry', 'document', 'declaration', 'effort_log', 'fiscal_rate',
    ]) {
      const { rows } = await agent.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table}`,
      );
      expect(rows[0]!.n).toMatch(/^\d+$/);
    }
  });

  it('can create a draft document and its lines', async () => {
    const { rows } = await agent.query<{ id: string }>(
      `INSERT INTO document (doc_type, company_id, subject, status, created_by_id)
       VALUES ('devis', $1, $2, 'brouillon', app.agent_user_id())
       RETURNING id`,
      [companyId, MARK],
    );
    draftId = rows[0]!.id;
    expect(draftId).toBeTruthy();

    await agent.query(
      `INSERT INTO document_line (document_id, label, unit_price_centimes, quantity_millis)
       VALUES ($1, 'Agent-drafted line', 500000, 1000)`,
      [draftId],
    );
    const lines = await agent.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM document_line WHERE document_id = $1',
      [draftId],
    );
    expect(lines.rows[0]!.n).toBe('1');
  });

  // --- The wall -------------------------------------------------------------

  it('CANNOT issue a document number', async () => {
    // The route that assigns a number. Refused twice over: no EXECUTE grant,
    // and the function itself rejects an agent session by name.
    await expect(
      agent.query('SELECT app.issue_document($1)', [draftId]),
    ).rejects.toThrow(/permission denied|cannot issue|insufficient/i);

    const { rows } = await owner.query<{ number: string | null; status: string }>(
      'SELECT number, status FROM document WHERE id = $1',
      [draftId],
    );
    expect(rows[0]!.number).toBeNull();
    expect(rows[0]!.status).toBe('brouillon');
  });

  it('CANNOT reach the gapless counter directly', async () => {
    await expect(
      agent.query(`SELECT app.next_document_number('facture', 2026)`),
    ).rejects.toThrow(/permission denied|does not exist/i);

    await expect(
      agent.query('SELECT * FROM document_counter'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT insert a document that is already issued', async () => {
    // The policy's WITH CHECK is what stops a number being filled in by hand,
    // bypassing the counter entirely.
    await expect(
      agent.query(
        `INSERT INTO document (doc_type, company_id, subject, status, number, number_year, number_seq, created_by_id)
         VALUES ('facture', $1, $2, 'emis', 'FAC-2026-9999', 2026, 9999, app.agent_user_id())`,
        [companyId, MARK],
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document WHERE number = 'FAC-2026-9999'`,
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('CANNOT update a fiscal rate', async () => {
    const before = await owner.query<{ key: string; rate_bp: number }>(
      'SELECT key, rate_bp FROM fiscal_rate ORDER BY key',
    );

    await agent
      .query('UPDATE fiscal_rate SET rate_bp = 9999')
      .catch(() => undefined);
    await agent
      .query(`INSERT INTO fiscal_rate (key, rate_bp, effective_from)
              VALUES ('tva_standard', 9999, current_date + 1)`)
      .catch(() => undefined);

    const after = await owner.query<{ key: string; rate_bp: number }>(
      'SELECT key, rate_bp FROM fiscal_rate ORDER BY key',
    );
    // Unchanged is the property that matters, whichever layer refused it.
    expect(after.rows).toEqual(before.rows);
  });

  it('CANNOT update or delete anything, anywhere', async () => {
    const snapshot = async () => {
      const { rows } = await owner.query<{ t: string; n: string }>(`
        SELECT 'company' AS t, count(*)::text AS n FROM company
        UNION ALL SELECT 'finance_entry', count(*)::text FROM finance_entry
        UNION ALL SELECT 'document', count(*)::text FROM document
        UNION ALL SELECT 'service_price', count(*)::text FROM service_price
        ORDER BY 1`);
      return rows;
    };
    const before = await snapshot();

    for (const statement of [
      `UPDATE company SET name = 'hijacked'`,
      `DELETE FROM finance_entry`,
      `DELETE FROM document`,
      `UPDATE finance_entry SET amount_centimes = 1`,
      `UPDATE service_price SET unit_price_centimes = 1`,
      `DELETE FROM company`,
    ]) {
      await agent.query(statement).catch(() => undefined);
    }

    expect(await snapshot()).toEqual(before);
    const hijacked = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM company WHERE name = 'hijacked'`,
    );
    expect(hijacked.rows[0]!.n).toBe('0');
  });

  it('CANNOT read password hashes', async () => {
    await expect(
      agent.query('SELECT password_hash FROM app_user'),
    ).rejects.toThrow(/permission denied/i);

    // The directory it does get cannot expose the column even by accident.
    const { rows } = await agent.query('SELECT * FROM app.team_directory LIMIT 1');
    expect(Object.keys(rows[0] ?? {})).not.toContain('password_hash');
  });

  it('CANNOT post automatic revenue or forge a ledger source', async () => {
    for (const statement of [
      `INSERT INTO finance_entry (direction, amount_centimes, entry_date, category,
         payment_method, description, is_automatic, recorded_by_id)
       VALUES ('income', 999999, current_date, 'facture', 'virement', '${MARK}', true, app.agent_user_id())`,
      `INSERT INTO finance_entry (direction, amount_centimes, entry_date, category,
         payment_method, description, is_automatic, recorded_by_id)
       VALUES ('income', 999999, current_date, 'facture', 'virement', '${MARK}', false, NULL)`,
    ]) {
      await agent.query(statement).catch(() => undefined);
    }

    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM finance_entry WHERE description = $1',
      [MARK],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('CANNOT create tables or otherwise change the schema', async () => {
    await expect(
      agent.query('CREATE TABLE agent_backdoor (x int)'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('holds no bypass and is not an admin', async () => {
    const { rows } = await agent.query<{
      is_agent: boolean; is_admin: boolean; is_authenticated: boolean; is_bootstrap: boolean;
    }>(`SELECT app.is_agent() AS is_agent, app.is_admin() AS is_admin,
               app.is_authenticated() AS is_authenticated, app.is_bootstrap() AS is_bootstrap`);
    const ctx = rows[0]!;
    expect(ctx.is_agent).toBe(true);
    expect(ctx.is_admin).toBe(false);
    // It is not "a user" either: every human policy is written against
    // is_authenticated(), so the agent gets none of them by default.
    expect(ctx.is_authenticated).toBe(false);
    expect(ctx.is_bootstrap).toBe(false);

    const bypass = await agent.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
    expect(bypass.rows[0]!.rolsuper).toBe(false);
  });
});
