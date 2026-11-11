import { redirect } from 'next/navigation';
import { requireClientPage } from '../session';
import { withClient } from '@/db/session';
import { listPortalDocuments, listPortalPayments, type PortalDocument } from '@/lib/client-portal-queries';
import { summariseBilling } from '@/lib/client-relationship';
import { casablancaDay, formatDate } from '@/lib/format';
import { formatMAD } from '@/lib/money';
import { PortalTitle } from '../PortalTitle';

export const dynamic = 'force-dynamic';

const METHOD: Record<string, string> = {
  virement: 'Bank transfer',
  especes: 'Cash',
  cheque: 'Cheque',
  carte: 'Card',
  autre: 'Other',
};

/** What is left to pay on one invoice, never below zero. */
function left(d: PortalDocument): bigint {
  if (d.status === 'paye') return 0n;
  const due = BigInt(d.net_to_collect ?? d.total_incl_vat) - BigInt(d.paid);
  return due > 0n ? due : 0n;
}

/**
 * Their invoices, their quotes, and every payment we have recorded.
 *
 * The figures at the top are the same definitions the team's own client page
 * uses (`summariseBilling`), computed from the same rows listed underneath, so
 * the total and the list cannot disagree. Payments are listed in full and for
 * good: a reversed payment stays, marked, next to its reversal.
 */
export default async function PortalBilling() {
  const session = await requireClientPage();
  if (session.user.mustChangePassword) redirect('/portal/account');

  const { documents, payments } = await withClient(session.user.id, async (tx) => ({
    documents: await listPortalDocuments(tx),
    payments: await listPortalPayments(tx),
  }));

  const today = casablancaDay();
  const sums = summariseBilling(documents);
  const invoices = documents.filter((d) => d.doc_type === 'facture');
  const quotes = documents.filter((d) => d.doc_type === 'devis');
  const credits = documents.filter((d) => d.doc_type === 'avoir');
  const open = invoices.filter((d) => left(d) > 0n);
  const overdue = open.filter((d) => d.due_date && d.due_date < today);
  // The account to pay into: the one printed on the newest open invoice, so
  // this page never says something different from the paper they hold.
  const bank = open.find((d) => d.issuer_bank_rib);

  return (
    <>
      <PortalTitle
        eyebrow={session.user.companyName ?? ''}
        title="Invoices & payments"
        lead="Everything we have invoiced you, what has been paid, and what is still open. Each document opens as the PDF we sent."
      />

      <dl className="vix-figures mt-10">
        <div>
          <dt className="vix-meta">{sums.outstanding < 0n ? 'In your favour' : 'Still to pay'}</dt>
          <dd className="vix-figure">{formatMAD(sums.outstanding < 0n ? -sums.outstanding : sums.outstanding)}</dd>
          <dd className="vix-quiet mt-1">
            {sums.credited > 0n && <>After {formatMAD(sums.credited)} in credit notes. </>}
            {open.length === 0
              ? 'Nothing open.'
              : `${open.length} invoice${open.length === 1 ? '' : 's'} open${overdue.length ? ` · ${overdue.length} past due` : ''}`}
          </dd>
        </div>
        <div>
          <dt className="vix-meta">Paid so far</dt>
          <dd className="vix-figure">{formatMAD(sums.collected)}</dd>
        </div>
        <div>
          <dt className="vix-meta">Invoiced in total</dt>
          <dd className="vix-figure">{formatMAD(sums.billed)}</dd>
        </div>
      </dl>

      {bank && (
        <section className="vix-card mt-8 px-6 py-6">
          <h2 className="vix-meta">How to pay</h2>
          <p className="vix-body mt-3">
            By bank transfer to SOCIETE VIXART SARL. Put the invoice number in the transfer reference.
          </p>
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {bank.issuer_bank_name && (
              <div><dt className="vix-meta">Bank</dt><dd className="mt-1">{bank.issuer_bank_name}</dd></div>
            )}
            <div><dt className="vix-meta">RIB</dt><dd className="mt-1 tabular-nums select-all">{bank.issuer_bank_rib}</dd></div>
            {bank.issuer_bank_iban && (
              <div><dt className="vix-meta">IBAN</dt><dd className="mt-1 tabular-nums select-all">{bank.issuer_bank_iban}</dd></div>
            )}
            {bank.issuer_bank_swift && (
              <div><dt className="vix-meta">SWIFT</dt><dd className="mt-1 tabular-nums select-all">{bank.issuer_bank_swift}</dd></div>
            )}
          </dl>
        </section>
      )}

      <section className="mt-16">
        <h2 className="vix-h2">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="vix-body mt-4">No invoice yet.</p>
        ) : (
          <ul className="mt-6">
            {invoices.map((d) => {
              const remaining = left(d);
              const late = remaining > 0n && d.due_date !== null && d.due_date < today;
              return (
                <li key={d.id} className="vix-row">
                  <div className="min-w-0">
                    <p className="font-semibold tabular-nums">{d.number}</p>
                    {d.subject && <p className="vix-quiet truncate">{d.subject}</p>}
                    <p className="vix-quiet">
                      Issued {formatDate(d.issue_date)}
                      {d.due_date && <> · due {formatDate(d.due_date)}</>}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular-nums">{formatMAD(BigInt(d.net_to_collect ?? d.total_incl_vat))}</p>
                    {remaining === 0n ? (
                      <span className="vix-tag">Paid</span>
                    ) : (
                      <span className={late ? 'vix-tag vix-tag-strong' : 'vix-tag'}>
                        {late ? 'Past due' : 'Open'} · {formatMAD(remaining)} left
                      </span>
                    )}
                  </div>
                  <a href={`/portal/billing/${d.id}/pdf`} className="vix-btn vix-btn-quiet vix-btn-small" target="_blank" rel="noopener">
                    PDF
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {quotes.length > 0 && (
        <section className="mt-16">
          <h2 className="vix-h2">Quotes</h2>
          <ul className="mt-6">
            {quotes.map((d) => (
              <li key={d.id} className="vix-row">
                <div className="min-w-0">
                  <p className="font-semibold tabular-nums">{d.number}</p>
                  {d.subject && <p className="vix-quiet truncate">{d.subject}</p>}
                  <p className="vix-quiet">Sent {formatDate(d.issue_date)}</p>
                </div>
                <p className="text-right tabular-nums">{formatMAD(BigInt(d.total_incl_vat))}</p>
                <a href={`/portal/billing/${d.id}/pdf`} className="vix-btn vix-btn-quiet vix-btn-small" target="_blank" rel="noopener">
                  PDF
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {credits.length > 0 && (
        <section className="mt-16">
          <h2 className="vix-h2">Credit notes</h2>
          <ul className="mt-6">
            {credits.map((d) => (
              <li key={d.id} className="vix-row">
                <div className="min-w-0">
                  <p className="font-semibold tabular-nums">{d.number}</p>
                  <p className="vix-quiet">Issued {formatDate(d.issue_date)}</p>
                </div>
                <p className="text-right tabular-nums">{formatMAD(BigInt(d.total_incl_vat))}</p>
                <a href={`/portal/billing/${d.id}/pdf`} className="vix-btn vix-btn-quiet vix-btn-small" target="_blank" rel="noopener">
                  PDF
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-16">
        <h2 className="vix-h2">Payments received</h2>
        {payments.length === 0 ? (
          <p className="vix-body mt-4">No payment recorded yet.</p>
        ) : (
          <ul className="mt-6">
            {payments.map((p) => {
              const amount = BigInt(p.amount_centimes);
              return (
                <li key={p.id} className="vix-row vix-row-2">
                  <div className="min-w-0">
                    <p className={`tabular-nums font-semibold ${p.reversed ? 'line-through opacity-60' : ''}`}>
                      {formatMAD(amount)}
                    </p>
                    <p className="vix-quiet">
                      {formatDate(p.paid_on)} · {METHOD[p.method] ?? p.method} ·{' '}
                      <span className="whitespace-nowrap">invoice {p.number}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    {p.is_reversal && <span className="vix-tag">Cancels a payment</span>}
                    {p.reversed && <span className="vix-tag">Cancelled</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="vix-quiet mt-8">
          A payment you have made and do not see here may still be on its way to
          us. Send us the transfer receipt under “Messages” and we will match it.
        </p>
      </section>
    </>
  );
}
