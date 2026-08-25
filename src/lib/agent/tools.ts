import 'server-only';

import { sql } from 'drizzle-orm';
import { asAgent } from './db';
import {
  monthStart,
  parseDate,
  source,
  today,
  type ToolResult,
} from './contract';

/**
 * VIXART OS — the finance agent's tools.
 *
 * Every one of these runs on the restricted agent role. Money stays in centimes
 * as strings across the boundary: a bigint does not survive JSON, and turning
 * it into a Number is exactly the bug the whole codebase is built to avoid.
 * Formatting happens at the edge, with src/lib/money.ts.
 */

type Row = Record<string, unknown>;

/** Is withholding still unset? It changes what net-to-collect means. */
async function withholdingCaveat(tx: Parameters<Parameters<typeof asAgent>[0]>[0]): Promise<string[]> {
  const result = await tx.execute<Row>(sql`
    SELECT coalesce((SELECT rate_bp FROM fiscal_rate
                      WHERE key = 'retenue_source_tva' AND effective_from <= current_date
                      ORDER BY effective_from DESC LIMIT 1), 0)::text AS bp,
           (SELECT count(*)::text FROM company WHERE retenue_source) AS affected
  `);
  const bp = Number(result.rows[0]?.bp ?? 0);
  const affected = Number(result.rows[0]?.affected ?? 0);

  if (bp === 0 && affected > 0) {
    return [
      `The withholding rate (retenue à la source, art. 117 bis) is still set to 0, ` +
        `pending the accountant. ${affected} client(s) are marked as withholding. ` +
        `Net to collect therefore equals the total including VAT — these figures are ` +
        `NOT final for those clients.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------

export interface TreasuryData {
  from: string;
  to: string;
  inCentimes: string;
  outCentimes: string;
  netCentimes: string;
  byCategory: Array<{ direction: string; category: string; centimes: string; count: number }>;
}

/** Money in, money out, net — over a period. */
export async function treasury(
  fromRaw: string | null,
  toRaw: string | null,
): Promise<ToolResult<TreasuryData>> {
  const from = parseDate(fromRaw, monthStart());
  const to = parseDate(toRaw, today());

  return asAgent(async (tx) => {
    const lines = await tx.execute<Row>(sql`
      SELECT id::text, direction, category, amount_centimes::text
        FROM finance_entry
       WHERE entry_date BETWEEN ${from}::date AND ${to}::date
       ORDER BY entry_date
    `);

    const rows = lines.rows;
    const sum = (d: string) =>
      rows
        .filter((r) => r.direction === d)
        .reduce<bigint>((a, r) => a + BigInt(String(r.amount_centimes)), 0n);

    const money = sum('income');
    const spend = sum('expense');

    const grouped = new Map<string, { centimes: bigint; count: number; direction: string }>();
    for (const r of rows) {
      const key = `${r.direction}:${r.category}`;
      const current = grouped.get(key) ?? {
        centimes: 0n,
        count: 0,
        direction: String(r.direction),
      };
      current.centimes += BigInt(String(r.amount_centimes));
      current.count += 1;
      grouped.set(key, current);
    }

    return {
      data: {
        from,
        to,
        inCentimes: money.toString(),
        outCentimes: spend.toString(),
        netCentimes: (money - spend).toString(),
        byCategory: [...grouped.entries()]
          .map(([key, v]) => ({
            direction: v.direction,
            category: key.split(':')[1] ?? '',
            centimes: v.centimes.toString(),
            count: v.count,
          }))
          .sort((a, b) => (BigInt(b.centimes) > BigInt(a.centimes) ? 1 : -1)),
      },
      sources: [source('finance_entry', rows.map((r) => String(r.id)), { range: { from, to } })],
      caveats:
        rows.length === 0
          ? ['No ledger entries at all in this period — this is an empty result, not a zero balance.']
          : undefined,
    };
  });
}

// ---------------------------------------------------------------------------

export interface ReceivablesData {
  totalOutstandingCentimes: string;
  buckets: Array<{ bucket: string; count: number; centimes: string }>;
  invoices: Array<{
    id: string; number: string; client: string; issueDate: string | null;
    dueDate: string | null; daysLate: number | null;
    totalInclVatCentimes: string; netToCollectCentimes: string;
  }>;
}

/** Who owes, how much, and how long it has been. */
export async function receivables(): Promise<ToolResult<ReceivablesData>> {
  return asAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT d.id::text, d.number, coalesce(d.client_name, c.name) AS client,
             d.issue_date::text AS issue_date, d.due_date::text AS due_date,
             CASE WHEN d.due_date IS NULL THEN NULL
                  ELSE (current_date - d.due_date) END AS days_late,
             d.total_incl_vat::text, d.net_to_collect::text
        FROM document d JOIN company c ON c.id = d.company_id
       WHERE d.doc_type = 'facture' AND d.status = 'emis'
       ORDER BY d.due_date NULLS LAST, d.number
    `);

    const invoices = result.rows.map((r) => ({
      id: String(r.id),
      number: String(r.number),
      client: String(r.client),
      issueDate: (r.issue_date as string) ?? null,
      dueDate: (r.due_date as string) ?? null,
      daysLate: r.days_late === null ? null : Number(r.days_late),
      totalInclVatCentimes: String(r.total_incl_vat),
      netToCollectCentimes: String(r.net_to_collect),
    }));

    const bucketOf = (days: number | null) => {
      if (days === null) return 'no due date';
      if (days <= 0) return 'not yet due';
      if (days <= 30) return '1–30 days late';
      if (days <= 60) return '31–60 days late';
      if (days <= 90) return '61–90 days late';
      return 'over 90 days late';
    };

    const buckets = new Map<string, { count: number; centimes: bigint }>();
    let total = 0n;
    for (const inv of invoices) {
      const key = bucketOf(inv.daysLate);
      const current = buckets.get(key) ?? { count: 0, centimes: 0n };
      current.count += 1;
      current.centimes += BigInt(inv.netToCollectCentimes);
      buckets.set(key, current);
      total += BigInt(inv.netToCollectCentimes);
    }

    return {
      data: {
        totalOutstandingCentimes: total.toString(),
        buckets: [...buckets.entries()].map(([bucket, v]) => ({
          bucket,
          count: v.count,
          centimes: v.centimes.toString(),
        })),
        invoices,
      },
      sources: [source('document', invoices.map((i) => i.id))],
      caveats: [
        ...(await withholdingCaveat(tx)),
        ...(invoices.length === 0
          ? ['No issued unpaid invoices. Nothing is outstanding.']
          : []),
      ],
    };
  });
}

// ---------------------------------------------------------------------------

export interface ExpensesData {
  from: string;
  to: string;
  totalCentimes: string;
  recoverableVatCentimes: string;
  byCategory: Array<{ category: string; centimes: string; vatCentimes: string; count: number }>;
}

/** What went out, by category, with the VAT contained in it. */
export async function expenses(
  fromRaw: string | null,
  toRaw: string | null,
): Promise<ToolResult<ExpensesData>> {
  const from = parseDate(fromRaw, monthStart());
  const to = parseDate(toRaw, today());

  return asAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT id::text, category, amount_centimes::text, vat_centimes::text
        FROM finance_entry
       WHERE direction = 'expense'
         AND entry_date BETWEEN ${from}::date AND ${to}::date
       ORDER BY entry_date
    `);

    const rows = result.rows;
    const grouped = new Map<string, { centimes: bigint; vat: bigint; count: number }>();
    let total = 0n;
    let vatTotal = 0n;

    for (const r of rows) {
      const amount = BigInt(String(r.amount_centimes));
      const vat = BigInt(String(r.vat_centimes));
      const key = String(r.category);
      const current = grouped.get(key) ?? { centimes: 0n, vat: 0n, count: 0 };
      current.centimes += amount;
      current.vat += vat;
      current.count += 1;
      grouped.set(key, current);
      total += amount;
      vatTotal += vat;
    }

    return {
      data: {
        from,
        to,
        totalCentimes: total.toString(),
        recoverableVatCentimes: vatTotal.toString(),
        byCategory: [...grouped.entries()]
          .map(([category, v]) => ({
            category,
            centimes: v.centimes.toString(),
            vatCentimes: v.vat.toString(),
            count: v.count,
          }))
          .sort((a, b) => (BigInt(b.centimes) > BigInt(a.centimes) ? 1 : -1)),
      },
      sources: [source('finance_entry', rows.map((r) => String(r.id)), { range: { from, to } })],
      caveats: [
        'Recoverable VAT is the VAT recorded on each expense line. Lines entered ' +
          'without a VAT figure count as 0, so this is a floor, not a certainty.',
      ],
    };
  });
}

// ---------------------------------------------------------------------------

export interface CalendarData {
  from: string;
  to: string;
  declarations: Array<{
    id: string; kind: string; periodLabel: string; dueDate: string;
    status: string; amountCentimes: string | null; daysUntil: number;
  }>;
}

/** What is due fiscally, and when. */
export async function calendar(
  fromRaw: string | null,
  toRaw: string | null,
): Promise<ToolResult<CalendarData>> {
  const from = parseDate(fromRaw, today());
  const to = parseDate(toRaw, `${new Date().getFullYear()}-12-31`);

  return asAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      SELECT id::text, kind, period_label, due_date::text AS due_date, status,
             amount_centimes::text, (due_date - current_date) AS days_until
        FROM declaration
       WHERE due_date BETWEEN ${from}::date AND ${to}::date
       ORDER BY due_date
    `);

    const declarations = result.rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      periodLabel: String(r.period_label),
      dueDate: String(r.due_date),
      status: String(r.status),
      amountCentimes: r.amount_centimes === null ? null : String(r.amount_centimes),
      daysUntil: Number(r.days_until),
    }));

    const caveats: string[] = [];
    if (declarations.length === 0) {
      caveats.push(
        'No declarations are recorded in this window. That means none have been ' +
          'entered into the calendar — it does NOT mean nothing is due. The fiscal ' +
          'calendar has to be populated before it can warn about anything.',
      );
    }
    if (declarations.some((d) => d.amountCentimes === null)) {
      caveats.push('Some declarations have no amount yet; those are deadlines, not figures.');
    }
    caveats.push(
      'The team is treated as prestataire, so no CNSS or IR deadlines are tracked. ' +
        'If anyone moves to salarié status those rows have to be added.',
    );

    return {
      data: { from, to, declarations },
      sources: [source('declaration', declarations.map((d) => d.id), { range: { from, to } })],
      caveats,
    };
  });
}

// ---------------------------------------------------------------------------

export interface MarginData {
  from: string;
  to: string;
  companies: Array<{
    companyId: string; company: string;
    revenueCentimes: string; directCostCentimes: string;
    cashMarginCentimes: string; effortMinutes: number;
    invoiceIds: string[];
  }>;
}

/** Revenue against cash cost and logged effort, per client. */
export async function margin(
  fromRaw: string | null,
  toRaw: string | null,
  companyName: string | null,
): Promise<ToolResult<MarginData>> {
  const from = parseDate(fromRaw, `${new Date().getFullYear()}-01-01`);
  const to = parseDate(toRaw, today());

  return asAgent(async (tx) => {
    const result = await tx.execute<Row>(sql`
      WITH paid AS (
        SELECT d.company_id, d.id::text AS doc_id, d.net_to_collect
          FROM document d
         WHERE d.doc_type = 'facture' AND d.status = 'paye'
           AND d.issue_date BETWEEN ${from}::date AND ${to}::date
      ),
      costs AS (
        SELECT f.company_id, sum(f.amount_centimes) AS spent
          FROM finance_entry f
         WHERE f.direction = 'expense' AND f.company_id IS NOT NULL
           AND f.entry_date BETWEEN ${from}::date AND ${to}::date
         GROUP BY f.company_id
      ),
      effort AS (
        SELECT p.company_id, sum(e.minutes)::int AS minutes
          FROM effort_log e
          JOIN task t   ON t.id = e.task_id
          JOIN project p ON p.id = t.project_id
         WHERE e.logged_on BETWEEN ${from}::date AND ${to}::date
         GROUP BY p.company_id
      )
      SELECT c.id::text AS company_id, c.name,
             coalesce(sum(paid.net_to_collect), 0)::text AS revenue,
             coalesce(max(costs.spent), 0)::text          AS direct_cost,
             coalesce(max(effort.minutes), 0)             AS minutes,
             coalesce(array_agg(paid.doc_id) FILTER (WHERE paid.doc_id IS NOT NULL),
                      ARRAY[]::text[])                    AS invoice_ids
        FROM company c
        LEFT JOIN paid   ON paid.company_id   = c.id
        LEFT JOIN costs  ON costs.company_id  = c.id
        LEFT JOIN effort ON effort.company_id = c.id
       WHERE (${companyName}::text IS NULL OR c.name ILIKE '%' || ${companyName} || '%')
       GROUP BY c.id, c.name
      HAVING coalesce(sum(paid.net_to_collect), 0) > 0
          OR coalesce(max(costs.spent), 0) > 0
          OR coalesce(max(effort.minutes), 0) > 0
       ORDER BY coalesce(sum(paid.net_to_collect), 0) DESC
    `);

    const companies = result.rows.map((r) => {
      const revenue = BigInt(String(r.revenue));
      const cost = BigInt(String(r.direct_cost));
      return {
        companyId: String(r.company_id),
        company: String(r.name),
        revenueCentimes: revenue.toString(),
        directCostCentimes: cost.toString(),
        cashMarginCentimes: (revenue - cost).toString(),
        effortMinutes: Number(r.minutes),
        invoiceIds: (r.invoice_ids as string[]) ?? [],
      };
    });

    return {
      data: { from, to, companies },
      sources: [
        source('document', companies.flatMap((c) => c.invoiceIds), { range: { from, to } }),
        source('company', companies.map((c) => c.companyId)),
      ],
      caveats: [
        'This is a CASH margin, not a loaded one. Revenue counts only PAID invoices; ' +
          'cost counts only expenses tagged to the client. Labour appears as minutes, ' +
          'not money — there is no cost-per-hour in the database, so salaries and ' +
          'overheads are NOT deducted. The real margin is lower than this.',
        ...(companies.some((c) => c.effortMinutes === 0)
          ? ['Some clients show 0 minutes because no effort has been logged against their tasks, not because none was spent.']
          : []),
      ],
    };
  });
}

// ---------------------------------------------------------------------------

export interface DraftInvoiceData {
  documentId: string;
  lineCount: number;
  subtotalCentimes: string;
  company: string;
}

/**
 * Writes a DRAFT. Never a number, never issued.
 *
 * The database enforces that independently: the agent's INSERT policy requires
 * status = 'brouillon' with a null number, and app.issue_document() refuses an
 * agent session outright. This function could be wrong and the invariant would
 * still hold.
 */
export async function draftInvoice(
  dealId: string | null,
  companyId: string | null,
  subject: string | null,
): Promise<ToolResult<DraftInvoiceData>> {
  if (!dealId && !companyId) {
    throw new Error('Give either a deal id or a company id to draft from.');
  }

  return asAgent(async (tx) => {
    const setup = await tx.execute<Row>(sql`
      SELECT c.id::text AS company_id, c.name, c.retenue_source,
             coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key = 'tva_standard' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 2000) AS vat_bp,
             coalesce((SELECT rate_bp FROM fiscal_rate
                        WHERE key = 'retenue_source_tva' AND effective_from <= current_date
                        ORDER BY effective_from DESC LIMIT 1), 0) AS wh_bp,
             ${dealId}::uuid AS deal_id
        FROM company c
       WHERE c.id = coalesce(
               ${companyId}::uuid,
               (SELECT d.company_id FROM deal d WHERE d.id = ${dealId}::uuid))
    `);
    const s = setup.rows[0];
    if (!s) throw new Error('No such deal or client.');

    const created = await tx.execute<Row>(sql`
      INSERT INTO document (doc_type, company_id, deal_id, subject, status,
                            vat_rate_bp, withholding, withholding_rate_bp,
                            discount_centimes, created_by_id)
      VALUES ('facture', ${s.company_id}::uuid, ${dealId}::uuid, ${subject},
              'brouillon', ${s.vat_bp}, ${s.retenue_source}, ${s.wh_bp},
              coalesce((SELECT discount_centimes FROM deal WHERE id = ${dealId}::uuid), 0),
              app.agent_user_id())
      RETURNING id::text
    `);
    const documentId = String(created.rows[0]?.id);

    let lineCount = 0;
    if (dealId) {
      // Copy the deal's frozen lines. Snapshots of snapshots — the deal already
      // froze the price when the service was added.
      const copied = await tx.execute<Row>(sql`
        INSERT INTO document_line
          (document_id, service_id, label, unit, unit_price_centimes, quantity_millis, position)
        SELECT ${documentId}::uuid, service_id, label, unit,
               unit_price_centimes, quantity_millis, position
          FROM deal_line WHERE deal_id = ${dealId}::uuid ORDER BY position
        RETURNING id::text
      `);
      lineCount = copied.rows.length;
    }

    const totals = await tx.execute<Row>(sql`
      SELECT coalesce(sum((unit_price_centimes * quantity_millis + 500) / 1000), 0)::text AS subtotal
        FROM document_line WHERE document_id = ${documentId}::uuid
    `);

    return {
      data: {
        documentId,
        lineCount,
        subtotalCentimes: String(totals.rows[0]?.subtotal ?? '0'),
        company: String(s.name),
      },
      sources: [
        source('document', [documentId]),
        ...(dealId ? [source('deal', [dealId])] : []),
      ],
      caveats: [
        'This is a DRAFT. It has no number and no legal standing. Nothing has been ' +
          'sent to anyone. Amin has to open it and issue it, which is when it takes ' +
          'its number and becomes read-only.',
        ...(lineCount === 0
          ? ['No lines were copied — the draft is empty and needs services adding before it can be issued.']
          : []),
      ],
    };
  });
}
