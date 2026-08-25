/**
 * VIXART OS — the shape every agent tool returns.
 *
 * `sources` is not decoration. A finance agent that emits a confident figure
 * from nothing is worse than no agent, because Amin will act on it. Every tool
 * says which table it read, which rows, and over what range, and Le Comptable
 * is instructed to surface that in its answer.
 *
 * `caveats` carries what the number does NOT account for. The withholding rate
 * sitting at 0 is the live example: net-to-collect currently equals the total,
 * and a tool that reported it without saying so would be quietly wrong.
 */

export interface Source {
  table: string;
  /** Row ids the figures were computed from. Capped — see `truncated`. */
  ids: string[];
  /** Inclusive date range, ISO `YYYY-MM-DD`, when the query was time-bounded. */
  range?: { from: string; to: string };
  /** How many rows matched in total, when `ids` was capped. */
  total?: number;
  truncated?: boolean;
}

export interface ToolResult<T> {
  data: T;
  sources: Source[];
  /** Things the figure does not include, stated plainly. */
  caveats?: string[];
}

/** Ids are capped so a year of ledger lines cannot blow up the model context. */
export const MAX_IDS = 60;

export function source(
  table: string,
  ids: readonly string[],
  extra: Omit<Source, 'table' | 'ids'> = {},
): Source {
  const capped = ids.slice(0, MAX_IDS);
  return {
    table,
    ids: capped,
    ...extra,
    total: ids.length,
    truncated: ids.length > capped.length,
  };
}

/** `YYYY-MM-DD` or nothing. Rejects anything else rather than coercing it. */
export function parseDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

/** First day of the current month, Casablanca. */
export function monthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
