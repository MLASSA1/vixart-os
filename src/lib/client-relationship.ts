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
  status: string;
  total_incl_vat: string;
  net_to_collect: string | null;
  paid_at: string | null;
}

export interface BillingSummary {
  /** Issued and not cancelled. A draft is not a claim on anybody. */
  billed: bigint;
  /** Of that, what has actually been marked paid. */
  collected: bigint;
  /** The difference — the only one of the three anybody acts on. */
  outstanding: bigint;
  /** Drafts, counted but never added in. */
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

export function summariseBilling(rows: ReadonlyArray<BillingRow>): BillingSummary {
  /*
   * 'brouillon' is a draft and 'annule' is cancelled. Neither is money anybody
   * owes: a draft has no number and no legal standing, and a cancelled invoice
   * has been withdrawn. Counting either would overstate what is owed, which is
   * the direction of error that makes somebody chase a client for nothing.
   */
  const live = rows.filter((r) => r.status !== 'brouillon' && r.status !== 'annule');

  const billed = live.reduce((sum, r) => sum + owed(r), 0n);
  const collected = live
    .filter((r) => r.paid_at !== null && r.paid_at !== undefined)
    .reduce((sum, r) => sum + owed(r), 0n);

  return {
    billed,
    collected,
    outstanding: billed - collected,
    drafts: rows.filter((r) => r.status === 'brouillon').length,
  };
}
