/**
 * What a client has been billed, and what they still owe.
 *
 * Three numbers on the client's page, and the definitions are the whole of it —
 * so they live here, in one function, rather than being arithmetic inside a
 * component where nobody can check them.
 *
 * Deliberately NOT in SQL. The document list is already loaded and small, and a
 * separate aggregate query would be a second definition of "billed" free to
 * drift from the list printed underneath it — which is the version where the
 * total and the rows disagree and neither is obviously wrong.
 */

export interface BillingRow {
  /** 'facture' | 'devis' | 'avoir'. Only an invoice is money anybody owes. */
  doc_type: string;
  status: string;
  total_incl_vat: string;
  net_to_collect: string | null;
  /** Not read: `status` decides, and the database sets both together (0033). */
  paid_at?: string | null;
  /** Advances and part-payments already received, in centimes. */
  paid?: string | null;
}

export interface BillingSummary {
  /** Invoices issued and not cancelled. */
  billed: bigint;
  /** What has actually arrived: settled invoices in full, plus part-payments on open ones. */
  collected: bigint;
  /** Issued credit notes: what we have formally taken back off their bill. */
  credited: bigint;
  /**
   * What they still owe: billed, less collected, less credited. The only one
   * of these anybody acts on. NEGATIVE when the credit notes exceed what is
   * left — the client is in credit, and pages say so rather than print a
   * minus sign as a debt.
   */
  outstanding: bigint;
  /** Drafts of any kind, counted but never added in. */
  drafts: number;
}

/**
 * What we are actually waiting for on one document.
 *
 * `net_to_collect` where it exists, not the total. With withholding at source
 * the client pays the state part directly and sends us less than the invoice
 * says — so the total is what was billed and the net is what arrives. Treating
 * the total as owed leaves every withheld invoice looking permanently short.
 */
function owed(row: BillingRow): bigint {
  const net = row.net_to_collect;
  if (net !== null && net !== undefined && net !== '') return BigInt(net);
  return BigInt(row.total_incl_vat || '0');
}

const received = (row: BillingRow): bigint => BigInt(row.paid || '0');

/**
 * ONE DEFINITION, used by the client's page AND by Quotes & invoices.
 *
 * They used to disagree. This function counted every issued document, so an
 * issued QUOTE read as money the client owed and a CREDIT NOTE was added to the
 * debt instead of standing apart from it; and it ignored part-payments, so a
 * client who had paid a 50% deposit still owed the lot. The billing page had
 * the right rules all along. They are here now, and both pages call this.
 *
 *  - only invoices ('facture') that are issued ('emis') or paid ('paye');
 *    a draft has no number, a cancelled invoice was withdrawn, a quote is an
 *    offer and a credit note is not a debt;
 *  - collected = a paid invoice in full, plus whatever has already been
 *    received against one still open;
 *  - credited = every issued credit note ('avoir', issued or settled);
 *  - outstanding = billed minus collected minus credited.
 *
 * Credit notes reduce what a client owes: Amin's decision, 11 November 2026.
 * They are kept apart from `billed` and `collected` rather than netted into
 * either, so the three figures still mean what they say — what we invoiced,
 * what arrived, what we took back — and the balance is the arithmetic.
 * The Finance page's receivable figure follows the same rule.
 */
export function summariseBilling(rows: ReadonlyArray<BillingRow>): BillingSummary {
  const invoices = rows.filter(
    (r) => r.doc_type === 'facture' && (r.status === 'emis' || r.status === 'paye'),
  );

  const billed = invoices.reduce((sum, r) => sum + owed(r), 0n);
  const collected = invoices.reduce(
    (sum, r) => sum + (r.status === 'paye' ? owed(r) : received(r)),
    0n,
  );

  const credited = rows
    .filter((r) => r.doc_type === 'avoir' && (r.status === 'emis' || r.status === 'paye'))
    .reduce((sum, r) => sum + owed(r), 0n);

  return {
    billed,
    collected,
    credited,
    outstanding: billed - collected - credited,
    drafts: rows.filter((r) => r.status === 'brouillon').length,
  };
}

// ---------------------------------------------------------------------------
// Payment habits — how this client actually pays, worked out from their
// invoices. Nothing to type in and nothing estimated: every figure is a count
// or an average of real dates, and each one says when there is not enough
// history to mean anything.
// ---------------------------------------------------------------------------

export interface HabitRow extends BillingRow {
  /** "2026-11-10". */
  issue_date: string | null;
  due_date?: string | null;
  /** The mode de règlement on the invoice. */
  payment_method?: string | null;
  /** The Casablanca calendar day it was marked paid, made on the server. */
  paid_day?: string | null;
}

export interface PaymentHabits {
  /** How they usually pay, and on how many of their invoices. */
  usualMethod: { method: string; count: number; of: number } | null;
  /** Average days from issue to payment, over invoices paid in full. */
  daysToPay: number | null;
  /** Average days after the due date (negative: early), where one was set. */
  daysLate: number | null;
  /** How many paid invoices those averages rest on. */
  paidCount: number;
  /** Open invoices whose due date has passed, and what they still owe. */
  overdue: { count: number; owed: bigint };
}

/** Whole days from one "YYYY-MM-DD" to another, independent of any time zone. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const mean = (xs: number[]) => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

/**
 * @param today the server's Casablanca day, "2026-11-10" — never the browser's.
 */
export function paymentHabits(rows: ReadonlyArray<HabitRow>, today: string): PaymentHabits {
  const invoices = rows.filter(
    (r) => r.doc_type === 'facture' && (r.status === 'emis' || r.status === 'paye'),
  );

  const counts = new Map<string, number>();
  for (const r of invoices) if (r.payment_method) counts.set(r.payment_method, (counts.get(r.payment_method) ?? 0) + 1);
  const withMethod = [...counts.values()].reduce((a, b) => a + b, 0);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const paid = invoices.filter((r) => r.status === 'paye' && r.paid_day && r.issue_date);

  const overdueRows = invoices.filter((r) => r.status === 'emis' && r.due_date && r.due_date < today);

  return {
    usualMethod: top ? { method: top[0], count: top[1], of: withMethod } : null,
    daysToPay: mean(paid.map((r) => daysBetween(r.issue_date!, r.paid_day!))),
    daysLate: mean(paid.filter((r) => r.due_date).map((r) => daysBetween(r.due_date!, r.paid_day!))),
    paidCount: paid.length,
    overdue: {
      count: overdueRows.length,
      owed: overdueRows.reduce((sum, r) => sum + owed(r) - received(r), 0n),
    },
  };
}
