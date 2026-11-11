import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paymentHabits, summariseBilling, type BillingRow, type HabitRow } from './client-relationship';

/**
 * The three numbers on a client's page.
 *
 * The client relationship page exists because opening a client showed their
 * identity and said nothing about the work or the money — so a client with a live
 * project and an unpaid invoice looked exactly like one we had never worked for.
 *
 * Of everything on that page, these three are the ones somebody acts on, and
 * every one of the ways to get them wrong is expensive in a specific direction:
 * count a draft and you chase a client for money they were never asked for;
 * count a cancelled invoice and you chase them for money that was withdrawn;
 * use the total instead of the net where withholding applies and every withheld
 * invoice looks permanently short.
 */

const row = (over: Partial<BillingRow> = {}): BillingRow => ({
  doc_type: 'facture',
  status: 'emis',
  total_incl_vat: '100000',
  net_to_collect: null,
  paid_at: null,
  ...over,
});

describe('what a client has been billed', () => {
  it('adds up issued invoices', () => {
    const s = summariseBilling([row(), row({ total_incl_vat: '50000' })]);
    expect(s.billed).toBe(150000n);
    expect(s.collected).toBe(0n);
    expect(s.outstanding).toBe(150000n);
  });

  it('never counts a draft', () => {
    // A draft has no number and no legal standing. Counting it would have
    // somebody chasing money the client was never asked for.
    const s = summariseBilling([row(), row({ status: 'brouillon', total_incl_vat: '999999' })]);
    expect(s.billed).toBe(100000n);
    expect(s.drafts).toBe(1);
  });

  it('never counts a cancelled invoice', () => {
    const s = summariseBilling([row(), row({ status: 'annule', total_incl_vat: '999999' })]);
    expect(s.billed).toBe(100000n);
  });

  it('subtracts what has actually been paid', () => {
    // Paid the way the database marks it: status and paid_at together (0033).
    const s = summariseBilling([
      row({ status: 'paye', paid_at: '2026-09-01' }),
      row({ total_incl_vat: '40000' }),
    ]);
    expect(s.billed).toBe(140000n);
    expect(s.collected).toBe(100000n);
    expect(s.outstanding).toBe(40000n);
  });

  it('waits for the net where the client withholds at source', () => {
    /*
     * With retenue à la source the client pays the state part directly and sends
     * us less than the invoice says. The total is what was billed; the net is
     * what arrives. Treating the total as owed leaves every withheld invoice
     * looking permanently unpaid by the difference.
     */
    const s = summariseBilling([row({ total_incl_vat: '100000', net_to_collect: '90000' })]);
    expect(s.billed).toBe(90000n);
    expect(s.outstanding).toBe(90000n);
  });

  it('treats a paid withheld invoice as settled, not as short', () => {
    const s = summariseBilling([
      row({ total_incl_vat: '100000', net_to_collect: '90000', status: 'paye', paid_at: '2026-09-01' }),
    ]);
    expect(s.outstanding, 'a withheld invoice looks unpaid after it was paid').toBe(0n);
  });

  it('is money in centimes, end to end', () => {
    // BigInt, never a float. A rounded dirham on an invoice total is the kind of
    // error that is only ever found by a client.
    const s = summariseBilling([row({ total_incl_vat: '1' })]);
    expect(typeof s.billed).toBe('bigint');
    expect(s.billed).toBe(1n);
  });

  /*
   * The three this function used to get wrong, each of which disagreed with
   * the Quotes & invoices page and each of which would have had somebody
   * chasing a client for the wrong amount.
   */
  it('never counts a quote, issued or not, as money owed', () => {
    const s = summariseBilling([row(), row({ doc_type: 'devis', total_incl_vat: '999999' })]);
    expect(s.billed, 'an issued quote is an offer, not a debt').toBe(100000n);
    expect(s.outstanding).toBe(100000n);
  });

  it('never adds a credit note to what is owed', () => {
    const s = summariseBilling([row(), row({ doc_type: 'avoir', total_incl_vat: '30000' })]);
    expect(s.billed, 'a credit note was added to the debt').toBe(100000n);
  });

  it('takes an issued credit note off what is owed (Amin, Nov 2026)', () => {
    const s = summariseBilling([row(), row({ doc_type: 'avoir', total_incl_vat: '30000' })]);
    expect(s.credited).toBe(30000n);
    expect(s.outstanding).toBe(70000n);
    expect(s.collected, 'a credit note is not money received').toBe(0n);
  });

  it('ignores a draft or cancelled credit note', () => {
    const s = summariseBilling([
      row(),
      row({ doc_type: 'avoir', status: 'brouillon', total_incl_vat: '30000' }),
      row({ doc_type: 'avoir', status: 'annule', total_incl_vat: '30000' }),
    ]);
    expect(s.outstanding).toBe(100000n);
  });

  it('goes below zero when credit exceeds what is left: the client is in credit', () => {
    const s = summariseBilling([row({ status: 'paye' }), row({ doc_type: 'avoir', total_incl_vat: '20000' })]);
    expect(s.outstanding).toBe(-20000n);
  });

  it('counts a deposit already received on an open invoice', () => {
    // A client who has paid 50% up front does not still owe the lot.
    const s = summariseBilling([row({ total_incl_vat: '100000', paid: '50000' })]);
    expect(s.collected).toBe(50000n);
    expect(s.outstanding).toBe(50000n);
  });

  it('says nothing about a client with no documents', () => {
    const s = summariseBilling([]);
    expect(s).toEqual({ billed: 0n, collected: 0n, credited: 0n, outstanding: 0n, drafts: 0 });
  });
});

describe('how a client pays, from their invoices', () => {
  const inv = (over: Partial<HabitRow> = {}): HabitRow => ({
    doc_type: 'facture', status: 'emis', total_incl_vat: '100000', net_to_collect: null,
    paid_at: null, paid: '0', issue_date: '2026-09-01', due_date: '2026-09-15',
    payment_method: 'virement', paid_day: null, ...over,
  });
  const today = '2026-11-10';

  it('names the usual method and how many invoices it rests on', () => {
    const h = paymentHabits([inv(), inv(), inv({ payment_method: 'cheque' })], today);
    expect(h.usualMethod).toEqual({ method: 'virement', count: 2, of: 3 });
  });

  it('averages days to pay and days past due over paid invoices only', () => {
    const h = paymentHabits([
      inv({ status: 'paye', issue_date: '2026-09-01', due_date: '2026-09-15', paid_day: '2026-09-11' }),
      inv({ status: 'paye', issue_date: '2026-10-01', due_date: '2026-10-15', paid_day: '2026-10-25' }),
      inv(), // open: says nothing about how long they take
    ], today);
    expect(h.paidCount).toBe(2);
    expect(h.daysToPay).toBe(17); // 10 and 24 days
    expect(h.daysLate).toBe(3);   // 4 early and 10 late
  });

  it('crosses month and year boundaries by calendar day', () => {
    const h = paymentHabits([inv({ status: 'paye', issue_date: '2025-12-28', due_date: null, paid_day: '2026-01-03' })], today);
    expect(h.daysToPay).toBe(6);
    expect(h.daysLate).toBeNull();
  });

  it('counts what is overdue now, net of anything already received', () => {
    const h = paymentHabits([
      inv({ due_date: '2026-11-01', paid: '30000' }),   // overdue, part-paid
      inv({ due_date: '2026-12-01' }),                  // not due yet
      inv({ status: 'paye', due_date: '2026-10-01', paid_day: '2026-10-20' }), // paid
    ], today);
    expect(h.overdue).toEqual({ count: 1, owed: 70000n });
  });

  it('ignores quotes, credit notes and drafts', () => {
    const h = paymentHabits([
      inv({ doc_type: 'devis', payment_method: 'especes' }),
      inv({ doc_type: 'avoir', status: 'paye', paid_day: '2026-09-02' }),
      inv({ status: 'brouillon', due_date: '2026-01-01' }),
    ], today);
    expect(h).toEqual({ usualMethod: null, daysToPay: null, daysLate: null, paidCount: 0, overdue: { count: 0, owed: 0n } });
  });
});

describe('the relationship page shows what the reader may see', () => {
  const page = () =>
    readFileSync(
      join(process.cwd(), 'src/app/(app)/(management)/companies/[id]/page.tsx'),
      'utf8',
    );
  const component = () =>
    readFileSync(
      join(process.cwd(), 'src/app/(app)/(management)/companies/[id]/Relationship.tsx'),
      'utf8',
    );

  it('does not even ask for invoices unless the reader is an administrator', () => {
    /*
     * `document` is admin-only at the policy layer, so a moderator's query
     * returns an empty list — and an empty invoices section reads as "this client
     * has never been invoiced", which is a lie told confidently. Not asking is
     * the honest version of not being allowed to know.
     */
    expect(page(), 'the document query is not gated on isAdmin').toMatch(
      /const documents = isAdmin\s*\n?\s*\?/,
    );
  });

  it('does not render the money section to a moderator', () => {
    expect(component()).toMatch(/\{isAdmin && \(/);
  });

  it('links every row to the record it names', () => {
    // The point of the page is to get from the client to the thing. A read-only
    // summary of something you then have to go and find is the problem, not the
    // fix.
    const text = component();
    for (const href of ['/projects/${p.id}', '/deals/${d.id}', '/documents/${d.id}', '/chat/${t.id}']) {
      expect(text, `no link to ${href}`).toContain(href);
    }
  });

  it('says which conversation the client can read', () => {
    // The two threads carry the same company name, and the only difference that
    // matters is whether the client reads every word.
    const text = component();
    expect(text).toContain('They read this');
    expect(text).toContain('The client cannot see this');
  });

  it('names an absent owner rather than leaving a blank', () => {
    // A project with no lead and a deal nobody is accountable for are the things
    // worth seeing on this page; an empty space is not a statement.
    const text = component();
    expect(text).toContain('no lead');
    expect(text).toContain('nobody assigned');
  });
});
