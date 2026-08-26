/**
 * VIXART OS — turning an Anthropic API failure into something a human can act on.
 *
 * Same problem as db-errors.ts, different source. The SDK puts the whole HTTP
 * body in `error.message`, so a billing failure reaches the screen as
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "Your credit balance is too low..."},"request_id":"req_011Ce..."}
 *
 * which tells the reader nothing and leaks a request id into the UI. What
 * someone standing in front of the panel needs is which of the handful of real
 * causes this is, and what they can do about it.
 *
 * Deliberately no fallback to the raw message: an unrecognised failure gets a
 * plain sentence and the status code. The raw text belongs in the server log,
 * not in front of whoever asked a question about invoices.
 */

export interface AgentFailure {
  /** One sentence, safe to show anyone. */
  message: string;
  /** True when trying the same question again might work. */
  retryable: boolean;
  /** HTTP status, when there was one. */
  status?: number;
}

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown };
  return typeof e?.status === 'number' ? e.status : undefined;
}

/** The API's own message, dug out of the JSON body the SDK stringifies. */
function innerMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const brace = raw.indexOf('{');
  if (brace === -1) return raw;
  try {
    const parsed = JSON.parse(raw.slice(brace)) as { error?: { message?: unknown } };
    const inner = parsed.error?.message;
    return typeof inner === 'string' ? inner : raw;
  } catch {
    return raw;
  }
}

export function readAgentError(error: unknown): AgentFailure {
  const status = statusOf(error);
  const inner = innerMessage(error);

  // Our own guard, thrown before any request is made.
  if (inner.includes('ANTHROPIC_API_KEY is not set')) {
    return { message: inner, retryable: false };
  }

  if (/credit balance is too low/i.test(inner)) {
    return {
      message:
        'The Anthropic account has no credit left, so the agent cannot answer. ' +
        'Add credit under Plans & Billing at console.anthropic.com. ' +
        'Every other screen works without it.',
      retryable: false,
      status,
    };
  }

  if (status === 401 || /authentication|invalid x-api-key/i.test(inner)) {
    return {
      message:
        'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env and restart the stack.',
      retryable: false,
      status,
    };
  }

  if (status === 403) {
    return { message: 'That key is not allowed to use this model.', retryable: false, status };
  }

  if (status === 429) {
    return {
      message: 'The API is rate limiting us. Wait a moment and ask again.',
      retryable: true,
      status,
    };
  }

  // 529 is Anthropic's "overloaded"; 5xx is theirs, not ours.
  if (status === 529 || (status !== undefined && status >= 500)) {
    return { message: 'The API is unavailable right now. Try again shortly.', retryable: true, status };
  }

  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(inner)) {
    return {
      message: 'Could not reach the API — check the server’s connection.',
      retryable: true,
      status,
    };
  }

  return {
    message: status
      ? `The agent could not answer (HTTP ${status}). The server log has the detail.`
      : 'The agent could not answer. The server log has the detail.',
    retryable: false,
    status,
  };
}
