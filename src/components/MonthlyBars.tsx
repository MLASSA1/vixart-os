/**
 * A month-by-month bar chart, drawn as inline SVG on the server.
 *
 * NO CHART LIBRARY, AND THAT IS THE POINT. The promise on the sign-in page is
 * "nothing leaves this machine", and every charting library of consequence
 * arrives from a CDN or drags a runtime into the bundle. An axis and some
 * rectangles are not worth either, and SVG rendered on the server needs no
 * JavaScript at all — the chart is in the HTML, so it prints, it works with the
 * network off, and it cannot flash empty while something hydrates.
 *
 * ONE COLOUR. Every series here is a single measure over time, so there is no
 * identity to encode and no second hue to justify. `--color-chart` (#8b5cf6)
 * was computed against the dark card before it was used: 4.1:1, where the
 * button violet only managed 3.1:1 there — legal for a graphic, and too faint
 * for something read at a glance (Night studio, Nov 2026). Two
 * measures that want comparing — tasks raised against tasks finished — are two
 * charts on a shared scale rather than two colours on one, which is also the
 * only honest way to compare them without a second axis.
 *
 * NOT EVERY BAR IS LABELLED. The newest month and the tallest one carry their
 * figure, because those are the two anybody looks for; the rest are a shape.
 * The full numbers are a keystroke away in the table underneath, which is also
 * what makes this readable to a screen reader and to somebody who cannot pick
 * the bars out by colour.
 */

import { formatMAD } from '@/lib/money';

export interface MonthPoint {
  /** 'YYYY-MM'. */
  month: string;
  value: number;
}

/** Jan … Déc, because every other date on this screen is French. */
const MONTH_FR = [
  'janv', 'févr', 'mars', 'avr', 'mai', 'juin',
  'juil', 'août', 'sept', 'oct', 'nov', 'déc',
];

/**
 * The figure, short enough to sit over a bar.
 *
 * No centimes: a chart is read at a glance and "13 400,00 DH" over a 26-pixel
 * mark is just a smear. The exact figures, with centimes, are in the table
 * under every chart and in the total beside it.
 */
function compact(value: number, money: boolean): string {
  const n = Math.round(value);
  if (!money) return String(n);
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function label(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_FR[Number(m) - 1] ?? m} ${y?.slice(2) ?? ''}`;
}

/**
 * Every month from the first to the last, including the empty ones.
 *
 * A month with nothing in it is the most interesting bar on the chart — it is
 * the month nobody won anything — and a query that groups by month simply does
 * not return it. Collapsing those silently turns a gap into a trend.
 */
export function fillMonths(points: MonthPoint[], upTo?: string): MonthPoint[] {
  if (points.length === 0) return [];
  const have = new Map(points.map((p) => [p.month, p.value]));
  const sorted = [...points].map((p) => p.month).sort();
  const first = sorted[0]!;
  const last = upTo && upTo > sorted[sorted.length - 1]! ? upTo : sorted[sorted.length - 1]!;

  const out: MonthPoint[] = [];
  let [y, m] = first.split('-').map(Number) as [number, number];
  for (let guard = 0; guard < 120; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ month: key, value: have.get(key) ?? 0 });
    if (key === last) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function MonthlyBars({
  title,
  points,
  money = false,
  /** Forces a shared ceiling, so two charts side by side can be compared. */
  scaleTo,
  caption,
}: {
  title: string;
  points: MonthPoint[];
  money?: boolean;
  scaleTo?: number;
  caption?: string;
}) {
  const show = (v: number) => (money ? formatMAD(BigInt(Math.round(v)) * 100n) : String(v));

  if (points.length === 0) {
    return (
      <figure className="card px-5 py-4">
        <figcaption className="label">{title}</figcaption>
        <p className="hint mt-3">Nothing recorded yet.</p>
      </figure>
    );
  }

  const peak = Math.max(...points.map((p) => p.value));
  const ceiling = Math.max(scaleTo ?? 0, peak, 1);
  const total = points.reduce((a, p) => a + p.value, 0);

  // A fixed drawing grid, scaled by the browser through the viewBox. Thin bars
  // with a 2px gutter, which is the surface showing through rather than a
  // border drawn on top.
  // The viewBox is scaled to the card's width, and a card in the two-column
  // grid is narrower than this — so everything shrinks. Type is sized for the
  // SHRUNK result, not for these coordinates: 11 here lands around 8px on screen.
  const W = 320;
  const PLOT = 96;
  /** Kept clear at the top so a value label always has somewhere to sit. */
  const LABEL_BAND = 16;
  const BASE = PLOT + 1;
  const slot = W / points.length;
  const barW = Math.min(26, Math.max(8, slot - 10));

  const peakIndex = points.findIndex((p) => p.value === peak);
  const lastIndex = points.length - 1;

  return (
    <figure className="card px-5 py-4">
      <figcaption className="label">{title}</figcaption>

      <svg
        viewBox={`0 0 ${W} ${BASE + 24}`}
        role="img"
        aria-label={`${title}. ${points.map((p) => `${label(p.month)}: ${show(p.value)}`).join('. ')}`}
        className="mt-3 w-full"
        style={{ height: 'auto' }}
      >
        {/* The baseline, recessive on purpose: it orients, it does not compete. */}
        <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="currentColor" strokeWidth="1" opacity="0.18" />

        {points.map((p, i) => {
          /*
           * Bars are scaled to leave a band free at the top.
           *
           * The first version let the tallest bar fill the plot, which left
           * its label nowhere to go but inside the mark — and a money label
           * ("36 000") is wider than the bar, so it clipped. Reserving the
           * headroom means every label sits above its bar, in ink, on the
           * surface, every time; there is no second case to get wrong.
           */
          const h = ceiling === 0 ? 0 : (p.value / ceiling) * (PLOT - LABEL_BAND);
          const x = i * slot + (slot - barW) / 2;
          const y = BASE - h;
          const r = Math.min(4, h / 2, barW / 2);
          const labelled = i === lastIndex || i === peakIndex;

          return (
            <g key={p.month}>
              {/* The hit target is the whole column, not the bar — a month with
                  nothing in it still has to be hoverable to say it is zero. */}
              <rect x={i * slot} y={0} width={slot} height={BASE} fill="transparent">
                <title>{`${label(p.month)} — ${show(p.value)}`}</title>
              </rect>

              {h > 0 ? (
                // Rounded at the data end, square where it meets the baseline.
                <path
                  d={`M ${x} ${BASE} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y}
                      L ${x + barW - r} ${y} Q ${x + barW} ${y} ${x + barW} ${y + r}
                      L ${x + barW} ${BASE} Z`}
                  fill="var(--color-chart)"
                  pointerEvents="none"
                />
              ) : (
                // A month that happened and produced nothing still gets a mark,
                // so the eye reads "zero" rather than "no data".
                <rect
                  x={x} y={BASE - 2} width={barW} height={2}
                  fill="currentColor" opacity="0.22" pointerEvents="none"
                />
              )}

              {labelled && p.value > 0 && (
                <text
                  // Clamped away from both edges: a label on the first or last
                  // month is wider than its bar and would otherwise run off.
                  x={Math.min(Math.max(x + barW / 2, 20), W - 20)}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize="12"
                  fontWeight="600"
                  fill="currentColor"
                  opacity="0.8"
                  pointerEvents="none"
                >
                  {compact(p.value, money)}
                </text>
              )}

              <text
                x={i * slot + slot / 2}
                y={BASE + 16}
                textAnchor="middle"
                fontSize="11"
                fill="currentColor"
                opacity="0.55"
                pointerEvents="none"
              >
                {label(p.month)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="hint">{caption ?? `${points.length} months`}</span>
        <span className="text-[13px] font-semibold tabular-nums">{show(total)} total</span>
      </div>

      {/* The numbers, for a screen reader and for anybody who wants the figure
          rather than the shape. */}
      <details className="mt-2">
        <summary className="hint cursor-pointer select-none">Show the figures</summary>
        <table className="mt-2 w-full text-[13px]">
          <tbody>
            {points.map((p) => (
              <tr key={p.month} className="border-b border-void/10 last:border-b-0">
                <td className="py-1">{label(p.month)}</td>
                <td className="py-1 text-right tabular-nums">{show(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
