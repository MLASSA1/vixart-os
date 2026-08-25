import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { calendar, draftInvoice, expenses, margin, receivables, treasury } from './tools';

/**
 * The six tools, against a real database, on the real agent role.
 *
 * The property under test is not "does it return a number" — it is
 * "does every number arrive with the rows it came from". A finance agent that
 * emits a confident figure from nothing is the failure mode this whole layer
 * exists to prevent, so every tool is checked for sources, and the ones whose
 * figures are incomplete are checked for saying so.
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
const MARK = 'ZZZ agent-tools probe';

describe.skipIf(!HAS_DB)('agent tools (integration)', () => {
  let owner: Client;
  let companyId: string;

  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    await owner.query("SET app.bootstrap = 'on'");
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM company ORDER BY name LIMIT 1`,
    );
    companyId = rows[0]!.id;

    // A declaration to read, so the calendar test exercises a populated path.
    await owner.query(
      `INSERT INTO declaration (kind, period_label, period_start, period_end, due_date, status, notes)
       VALUES ('tva', 'ZZZ-PROBE', date_trunc('quarter', current_date)::date,
               (date_trunc('quarter', current_date) + interval '3 months - 1 day')::date,
               current_date + 20, 'upcoming', $1)
       ON CONFLICT (kind, period_label) DO NOTHING`,
      [MARK],
    );
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.query("SET app.bootstrap = 'on'");
    await owner.query('DELETE FROM declaration WHERE notes = $1', [MARK]);
    await owner.query(
      `DELETE FROM document_line WHERE document_id IN (SELECT id FROM document WHERE subject = $1)`,
      [MARK],
    );
    await owner.query('ALTER TABLE document DISABLE TRIGGER document_immutable');
    await owner.query('DELETE FROM document WHERE subject = $1', [MARK]);
    await owner.query('ALTER TABLE document ENABLE TRIGGER document_immutable');
    await owner.end();
  });

  it('treasury reports in, out and net with its ledger rows', async () => {
    const r = await treasury('2026-01-01', '2026-12-31');
    expect(r.data.from).toBe('2026-01-01');
    expect(r.sources[0]!.table).toBe('finance_entry');
    expect(r.sources[0]!.range).toEqual({ from: '2026-01-01', to: '2026-12-31' });

    // Net is exactly in minus out, in centimes, never a float.
    const net = BigInt(r.data.inCentimes) - BigInt(r.data.outCentimes);
    expect(r.data.netCentimes).toBe(net.toString());
  });

  it('treasury says so when a period is empty rather than implying a zero balance', async () => {
    const r = await treasury('1999-01-01', '1999-01-31');
    expect(r.data.netCentimes).toBe('0');
    expect(r.caveats?.join(' ')).toMatch(/empty result, not a zero balance/i);
  });

  it('receivables ages invoices and flags the withholding caveat', async () => {
    const r = await receivables();
    expect(r.sources[0]!.table).toBe('document');

    const bucketTotal = r.data.buckets.reduce<bigint>((a, b) => a + BigInt(b.centimes), 0n);
    expect(r.data.totalOutstandingCentimes).toBe(bucketTotal.toString());

    // While the rate is 0, net-to-collect equals the total and the tool must
    // say so rather than presenting the figure as final.
    const { rows } = await owner.query<{ bp: string; affected: string }>(`
      SELECT coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key = 'retenue_source_tva' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 0)::text AS bp,
             (SELECT count(*)::text FROM company WHERE retenue_source) AS affected`);
    if (Number(rows[0]!.bp) === 0 && Number(rows[0]!.affected) > 0) {
      expect(r.caveats?.join(' ')).toMatch(/withholding rate.*still set to 0/i);
      expect(r.caveats?.join(' ')).toMatch(/NOT final/i);
    }
  });

  it('expenses groups by category and totals match the parts', async () => {
    const r = await expenses('2026-01-01', '2026-12-31');
    const summed = r.data.byCategory.reduce<bigint>((a, c) => a + BigInt(c.centimes), 0n);
    expect(r.data.totalCentimes).toBe(summed.toString());
    expect(r.caveats?.join(' ')).toMatch(/floor, not a certainty/i);
  });

  it('calendar returns declarations ordered by due date', async () => {
    const r = await calendar('2000-01-01', '2100-01-01');
    expect(r.sources[0]!.table).toBe('declaration');
    expect(r.data.declarations.length).toBeGreaterThan(0);

    const dates = r.data.declarations.map((d) => d.dueDate);
    expect([...dates].sort()).toEqual(dates);

    // Prestataire assumption has to be stated, not silently assumed.
    expect(r.caveats?.join(' ')).toMatch(/prestataire/i);
    expect(r.caveats?.join(' ')).toMatch(/CNSS|IR/);
  });

  it('calendar distinguishes "nothing recorded" from "nothing due"', async () => {
    const r = await calendar('1990-01-01', '1990-12-31');
    expect(r.data.declarations).toHaveLength(0);
    expect(r.caveats?.join(' ')).toMatch(/does NOT mean nothing is due/i);
  });

  it('margin is honest that labour is minutes, not money', async () => {
    const r = await margin('2026-01-01', '2026-12-31', null);
    const joined = r.caveats?.join(' ') ?? '';
    expect(joined).toMatch(/CASH margin, not a loaded one/i);
    expect(joined).toMatch(/salaries and overheads are NOT deducted/i);
    expect(joined).toMatch(/real margin is lower/i);

    for (const c of r.data.companies) {
      const expected = BigInt(c.revenueCentimes) - BigInt(c.directCostCentimes);
      expect(c.cashMarginCentimes).toBe(expected.toString());
    }
  });

  it('margin can be narrowed to one named client', async () => {
    const { rows } = await owner.query<{ name: string }>(
      'SELECT name FROM company ORDER BY name LIMIT 1',
    );
    const r = await margin('2026-01-01', '2026-12-31', rows[0]!.name);
    for (const c of r.data.companies) {
      expect(c.company.toLowerCase()).toContain(rows[0]!.name.toLowerCase().slice(0, 5));
    }
  });

  it('draft_invoice writes a draft with no number, and says nothing was sent', async () => {
    const r = await draftInvoice(null, companyId, MARK);
    expect(r.data.documentId).toBeTruthy();
    expect(r.caveats?.join(' ')).toMatch(/This is a DRAFT/);
    expect(r.caveats?.join(' ')).toMatch(/Nothing has been sent/i);

    const { rows } = await owner.query<{ status: string; number: string | null; created_by: string }>(
      `SELECT d.status, d.number, u.email AS created_by
         FROM document d LEFT JOIN app_user u ON u.id = d.created_by_id
        WHERE d.id = $1`,
      [r.data.documentId],
    );
    expect(rows[0]!.status).toBe('brouillon');
    expect(rows[0]!.number).toBeNull();
    // Attributable: the row says the agent wrote it.
    expect(rows[0]!.created_by).toBe('agent@vixart.local');
  });

  it('every tool returns sources for every figure it reports', async () => {
    const results = [
      await treasury('2026-01-01', '2026-12-31'),
      await receivables(),
      await expenses('2026-01-01', '2026-12-31'),
      await calendar('2000-01-01', '2100-01-01'),
      await margin('2026-01-01', '2026-12-31', null),
    ];
    for (const r of results) {
      expect(Array.isArray(r.sources)).toBe(true);
      expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) {
        expect(s.table).toBeTruthy();
        expect(Array.isArray(s.ids)).toBe(true);
        // Capped so a year of ledger lines cannot blow up the model context.
        expect(s.ids.length).toBeLessThanOrEqual(60);
      }
    }
  });
});
