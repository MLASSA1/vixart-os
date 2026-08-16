/**
 * VIXART OS — turning a database error into something a human can act on.
 *
 * Drizzle wraps the driver error: the message you get is
 * `Failed query: insert into "service_price" ... params: ...`, and the useful
 * parts — the constraint name, the SQLSTATE, the detail line — sit on
 * `error.cause`. Matching against `error.message` therefore silently never
 * matches, and the raw SQL (parameters included) gets shown to the user.
 *
 * This walks the cause chain and pulls out the fields that actually identify
 * what went wrong.
 */

export interface DbFailure {
  /** PostgreSQL constraint or index name, when the driver reported one. */
  constraint?: string;
  /** SQLSTATE, e.g. 23505 unique_violation, 42501 insufficient_privilege. */
  code?: string;
  detail?: string;
  /** The clean message, never the generated SQL. */
  message: string;
}

/** Walks `cause` until it finds a pg error, and reads its fields. */
export function readDbError(error: unknown): DbFailure {
  let current: unknown = error;
  let constraint: string | undefined;
  let code: string | undefined;
  let detail: string | undefined;
  let message = error instanceof Error ? error.message : String(error);

  for (let depth = 0; current && depth < 6; depth += 1) {
    const e = current as Record<string, unknown>;
    if (typeof e.constraint === 'string') constraint = e.constraint;
    if (typeof e.code === 'string') code = e.code;
    if (typeof e.detail === 'string') detail = e.detail;
    // Prefer a driver message over Drizzle's "Failed query: <sql>" wrapper.
    if (typeof e.message === 'string' && !e.message.startsWith('Failed query')) {
      message = e.message;
    }
    current = e.cause;
  }

  return { constraint, code, detail, message };
}

/** Messages shared by every module, keyed by constraint name. */
const BY_CONSTRAINT: Record<string, string> = {
  company_name_key: 'A record with this name already exists.',
  company_ice_shape: 'The ICE must be exactly 15 digits.',
  company_if_shape: 'The tax ID (IF) must be 6 to 9 digits.',
  contact_unique_primary:
    'This client already has a main contact. Clear the other one first.',
  contact_email_shape: 'That email address is not valid.',
  interaction_not_in_future:
    'The timeline records what happened, not what is planned — pick a past date.',
  service_name_key: 'A service with that name already exists.',
  service_price_version_key:
    'A price already starts on that date. Pick a different start date — existing versions are never overwritten.',
  service_price_non_negative: 'A price cannot be negative.',
  deal_lost_needs_reason:
    'A lost deal has to say why it was lost — that is the point of recording it.',
  deal_value_non_negative: 'The value cannot be negative.',
  deal_probability_range: 'Confidence must be between 0 and 100.',
  project_dates_ordered: 'The due date cannot be before the start date.',
  project_name_not_empty: 'The project needs a name.',
  task_title_not_empty: 'The task needs a title.',
};

/**
 * A readable sentence for a failed write. `extra` lets a module override or add
 * to the shared table without duplicating it.
 */
export function describeDbError(
  error: unknown,
  extra: Record<string, string> = {},
): string {
  const failure = readDbError(error);

  if (failure.constraint) {
    const known = extra[failure.constraint] ?? BY_CONSTRAINT[failure.constraint];
    if (known) return known;
  }

  // Messages raised deliberately by our own triggers are already written for a
  // human — pass them straight through.
  if (/^(Only a moderator|You can only|You can change|This task was|A price version|A tax parameter)/.test(failure.message)) {
    return failure.message;
  }

  switch (failure.code) {
    case '23505':
      return 'That already exists.';
    case '23503':
      return 'That refers to a record which no longer exists.';
    case '23514':
      return 'The database rejected those values.';
    case '42501':
      return 'You do not have permission for that.';
    default:
      break;
  }

  if (failure.message.includes('row-level security')) {
    return 'You do not have permission for that.';
  }

  // Never leak generated SQL or bound parameters into the interface.
  return failure.message.startsWith('Failed query')
    ? 'The database refused that change.'
    : failure.message;
}
