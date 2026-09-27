import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summariseBilling, type BillingRow } from './client-relationship';

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
    const s = summariseBilling([
      row({ paid_at: '2026-09-01' }),
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
      row({ total_incl_vat: '100000', net_to_collect: '90000', paid_at: '2026-09-01' }),
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

  it('says nothing about a client with no documents', () => {
    const s = summariseBilling([]);
    expect(s).toEqual({ billed: 0n, collected: 0n, outstanding: 0n, drafts: 0 });
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
