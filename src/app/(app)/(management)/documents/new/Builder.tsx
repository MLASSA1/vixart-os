'use client';

import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ErrorBanner } from '@/components/ui';
import { EMPTY_STATE, type FormState } from '@/lib/form-state';

/**
 * Write a quote or an invoice on one screen.
 *
 * The totals here are a PREVIEW and nothing more. The figures that end up on
 * the document are computed by app.issue_document() in PostgreSQL, from the
 * rows as they land, in integer centimes. This arithmetic exists so the person
 * typing can see where they are; if the two ever disagreed, the database is
 * right and this is the thing to fix.
 *
 * That is also why the maths below mirrors the SQL exactly — same rounding,
 * same order of operations — rather than doing what is convenient in JS.
 */

export interface ServiceOption {
  id: string;
  name: string;
  unitLabel: string;
  /** Current price in centimes, as a string: bigint does not cross the wire. */
  priceCentimes: string;
}

export interface ClientOption {
  id: string;
  name: string;
  legalName: string | null;
  ice: string | null;
  taxId: string | null;
  address: string | null;
  retenueSource: boolean;
}

interface Line {
  key: number;
  serviceId: string;
  label: string;
  unit: string;
  /** Kept as typed text — parsing on every keystroke fights the user. */
  price: string;
  quantity: string;
}

/** Dirhams string → centimes. Mirrors toCentimes, including the comma. */
function centimesOf(input: string): bigint {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return 0n;
  const [whole = '0', frac = ''] = cleaned.split('.');
  const cents = (frac + '00').slice(0, 2);
  return BigInt(whole || '0') * 100n + BigInt(cents || '0');
}

/** Quantity string → thousandths. */
function millisOf(input: string): bigint {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return 0n;
  const [whole = '0', frac = ''] = cleaned.split('.');
  const thousandths = (frac + '000').slice(0, 3);
  return BigInt(whole || '0') * 1000n + BigInt(thousandths || '0');
}

/** Half-up on a positive numerator, which is what the SQL does. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function formatMAD(centimes: bigint): string {
  const negative = centimes < 0n;
  const n = negative ? -centimes : centimes;
  const whole = (n / 100n).toString();
  const rest = (n % 100n).toString().padStart(2, '0');
  const spaced = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${spaced},${rest} DH`;
}

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function Builder({
  action,
  clients,
  services,
  today,
  defaultVatRateBp,
  withholdingRateBp,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  clients: readonly ClientOption[];
  services: readonly ServiceOption[];
  today: string;
  defaultVatRateBp: number;
  withholdingRateBp: number;
}) {
  const [state, formAction] = useActionState(action, EMPTY_STATE);

  const [docType, setDocType] = useState<'devis' | 'facture'>('devis');
  const [clientId, setClientId] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { key: 1, serviceId: '', label: '', unit: 'forfait', price: '', quantity: '1' },
  ]);
  const [discount, setDiscount] = useState('');
  const [exempt, setExempt] = useState(false);
  const [issueNow, setIssueNow] = useState(false);

  const client = clients.find((c) => c.id === clientId);
  const vatRateBp = exempt ? 0 : defaultVatRateBp;

  const totals = useMemo(() => {
    // Round each line the way the SQL does, then sum. Summing first and
    // rounding once would drift by a centime on long documents.
    const subtotal = lines.reduce(
      (acc, l) => acc + divRound(centimesOf(l.price) * millisOf(l.quantity), 1000n),
      0n,
    );
    const discountC = centimesOf(discount);
    const capped = discountC > subtotal ? subtotal : discountC;
    const excl = subtotal - capped;
    const vat = divRound(excl * BigInt(vatRateBp), 10_000n);
    const incl = excl + vat;
    const withheld =
      client?.retenueSource ? divRound(vat * BigInt(withholdingRateBp), 10_000n) : 0n;
    return { subtotal, capped, excl, vat, incl, withheld, net: incl - withheld };
  }, [lines, discount, vatRateBp, client, withholdingRateBp]);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickService(key: number, serviceId: string) {
    const s = services.find((x) => x.id === serviceId);
    if (!s) {
      updateLine(key, { serviceId: '', label: '', unit: 'forfait', price: '' });
      return;
    }
    // The catalog price fills the row and stays editable: a quoted price is a
    // decision, not a lookup, and this document keeps whatever is typed here.
    updateLine(key, {
      serviceId,
      label: s.name,
      unit: s.unitLabel,
      price: (BigInt(s.priceCentimes) / 100n).toString(),
    });
  }

  const isQuote = docType === 'devis';

  return (
    <form action={formAction}>
      <ErrorBanner message={state.error} />

      {/* ---- what and for whom ------------------------------------------ */}
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="label block">Document</span>
          <select
            name="docType"
            className="input"
            value={docType}
            onChange={(e) => setDocType(e.target.value as 'devis' | 'facture')}
          >
            <option value="devis">Devis — a quote</option>
            <option value="facture">Facture — an invoice</option>
          </select>
        </label>

        <label className="block">
          <span className="label block">Client</span>
          <select
            name="companyId"
            className="input"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Choose…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The identity that will be printed, shown before it is committed. */}
      {client && (
        <div className="mt-4 rounded-xl border border-void/15 bg-paper px-4 py-3">
          <p className="label">Printed on the document</p>
          <p className="mt-1 font-semibold">{client.legalName || client.name}</p>
          {client.address && <p className="prose-vixart">{client.address}</p>}
          <p className="hint mt-1">
            {client.ice ? `ICE ${client.ice}` : 'No ICE on file'}
            {client.taxId ? ` · IF ${client.taxId}` : ''}
            {client.retenueSource ? ' · retenue à la source applies' : ''}
          </p>
          {!client.ice && (
            <p className="mt-2 font-semibold">
              A Moroccan invoice must carry the client’s ICE. Add it on the client’s
              record before issuing this.
            </p>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-3">
        <label className="block">
          <span className="label block">{isQuote ? 'Date' : 'Issue date'}</span>
          <input type="date" name="issueDate" defaultValue={today} className="input" />
        </label>
        <label className="block">
          <span className="label block">{isQuote ? 'Valid until' : 'Due date'}</span>
          <input type="date" name="dueDate" className="input" />
        </label>
        <label className="block">
          <span className="label block">Subject</span>
          <input name="subject" className="input" placeholder="Brand film — phase 1" />
        </label>
      </div>

      {/* ---- the lines --------------------------------------------------- */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="label">Services</h2>
          <button
            type="button"
            className="btn btn-inverse btn-small"
            onClick={() =>
              setLines((prev) => [
                ...prev,
                {
                  key: (prev.at(-1)?.key ?? 0) + 1,
                  serviceId: '', label: '', unit: 'forfait', price: '', quantity: '1',
                },
              ])
            }
          >
            Add a line
          </button>
        </div>

        <div className="mt-3 space-y-3">
          {lines.map((line) => {
            const lineTotal = divRound(
              centimesOf(line.price) * millisOf(line.quantity),
              1000n,
            );
            return (
              <div key={line.key} className="rounded-xl border border-void/15 bg-surface p-4">
                {/* Parallel names: the action reads these as arrays. */}
                <input type="hidden" name="lineServiceId" value={line.serviceId} />
                <input type="hidden" name="lineUnit" value={line.unit} />

                <div className="grid gap-3 sm:grid-cols-12">
                  <label className="block sm:col-span-4">
                    <span className="label block">From the catalog</span>
                    <select
                      className="input"
                      value={line.serviceId}
                      onChange={(e) => pickService(line.key, e.target.value)}
                    >
                      <option value="">Free line…</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block sm:col-span-4">
                    <span className="label block">Description</span>
                    <input
                      name="lineLabel"
                      className="input"
                      value={line.label}
                      onChange={(e) => updateLine(line.key, { label: e.target.value })}
                      placeholder="What the client is paying for"
                    />
                  </label>

                  <label className="block sm:col-span-2">
                    <span className="label block">Unit price (DH)</span>
                    <input
                      name="linePrice"
                      inputMode="decimal"
                      className="input"
                      value={line.price}
                      onChange={(e) => updateLine(line.key, { price: e.target.value })}
                      placeholder="0"
                    />
                  </label>

                  <label className="block sm:col-span-2">
                    <span className="label block">Quantity</span>
                    <input
                      name="lineQuantity"
                      inputMode="decimal"
                      className="input"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    />
                  </label>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="hint">
                    {line.unit} · {formatMAD(lineTotal)}
                  </span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-inverse btn-small"
                      onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- money ------------------------------------------------------- */}
      <div className="mt-8 grid gap-8 sm:grid-cols-2">
        <div>
          <label className="block">
            <span className="label block">Discount (DH)</span>
            <input
              name="discount"
              inputMode="decimal"
              className="input"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder="0"
            />
            <span className="hint mt-1 block">
              An amount, not a percentage. Capped at the subtotal.
            </span>
          </label>

          <label className="mt-5 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[#6D28D9]"
              checked={exempt}
              onChange={(e) => setExempt(e.target.checked)}
            />
            <span>
              <span className="label block">Exempt from VAT</span>
              <span className="hint">A 0 % rate has to state why, in law.</span>
            </span>
          </label>
          <input type="hidden" name="vatRateBp" value={exempt ? 0 : defaultVatRateBp} />

          {exempt && (
            <label className="mt-3 block">
              <span className="label block">Legal reason for the exemption</span>
              <input
                name="vatExemptionReason"
                className="input"
                required
                placeholder="Article 92-I du CGI — export de services"
              />
            </label>
          )}

          <label className="mt-5 block">
            <span className="label block">Payment terms</span>
            <input
              name="paymentTerms"
              className="input"
              placeholder="Virement bancaire — 30 jours"
            />
          </label>
        </div>

        {/* Live preview. The database has the last word on all of it. */}
        <div className="rounded-[14px] bg-void p-6 text-pure">
          <p className="text-[12px] font-bold tracking-[0.09em] text-pure/45 uppercase">Preview</p>
          <dl className="mt-3 space-y-2">
            {totals.capped > 0n && (
              <>
                <div className="flex justify-between">
                  <dt>Subtotal</dt>
                  <dd>{formatMAD(totals.subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Discount</dt>
                  <dd>− {formatMAD(totals.capped)}</dd>
                </div>
              </>
            )}
            <div className="flex justify-between font-semibold">
              <dt>Total HT</dt>
              <dd>{formatMAD(totals.excl)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>TVA {(vatRateBp / 100).toFixed(0)} %</dt>
              <dd>{formatMAD(totals.vat)}</dd>
            </div>
            <div className="flex justify-between border-t-2 border-accent pt-2 text-lg font-bold">
              <dt>Total TTC</dt>
              <dd>{formatMAD(totals.incl)}</dd>
            </div>
            {totals.withheld > 0n && (
              <>
                <div className="flex justify-between">
                  <dt>Retenue à la source</dt>
                  <dd>− {formatMAD(totals.withheld)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Net à encaisser</dt>
                  <dd>{formatMAD(totals.net)}</dd>
                </div>
              </>
            )}
          </dl>
          <p className="mt-4 text-[13px] text-pure/50">
            Computed here so you can see it. The figures on the document itself are
            calculated by the database when it is issued.
          </p>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="label block">Notes on the document</span>
        <textarea name="notes" rows={2} className="input" />
      </label>

      {/* ---- save -------------------------------------------------------- */}
      <div className="mt-8 border-t border-void/15 pt-5">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="issueNow"
            value="yes"
            className="mt-1 h-4 w-4 accent-[#6D28D9]"
            checked={issueNow}
            onChange={(e) => setIssueNow(e.target.checked)}
          />
          <span>
            <span className="label block">Issue it straight away</span>
            <span className="hint">
              Assigns the number and freezes every figure.{' '}
              {isQuote
                ? 'A quote can be superseded by another quote.'
                : 'An issued invoice can never be edited — only corrected by a credit note.'}
            </span>
          </span>
        </label>

        <div className="mt-5 flex flex-wrap gap-3">
          <Submit
            label={issueNow ? `Create and issue this ${isQuote ? 'quote' : 'invoice'}` : 'Save as a draft'}
            busy="Working…"
          />
        </div>
      </div>
    </form>
  );
}
