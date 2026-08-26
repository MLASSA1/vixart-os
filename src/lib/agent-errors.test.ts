import { describe, expect, it } from 'vitest';
import { readAgentError } from './agent-errors';

/**
 * The panel shows whatever this returns, so the standard is: a sentence someone
 * can act on, and never the API's raw body.
 */

/** Shaped like a real SDK error: status, and the HTTP body as the message. */
function apiError(status: number, type: string, message: string) {
  const e = new Error(
    `${status} ${JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_011CeRzCoRh8iCgM8n4CpSA8' })}`,
  );
  (e as Error & { status: number }).status = status;
  return e;
}

describe('readAgentError', () => {
  it('names the real cause when the account is out of credit', () => {
    const r = readAgentError(
      apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'),
    );
    expect(r.message).toContain('no credit');
    expect(r.message).toContain('console.anthropic.com');
    expect(r.retryable).toBe(false);
  });

  it('points at the key when the key is rejected', () => {
    const r = readAgentError(apiError(401, 'authentication_error', 'invalid x-api-key'));
    expect(r.message).toContain('ANTHROPIC_API_KEY');
    expect(r.retryable).toBe(false);
  });

  it('marks rate limits and outages as worth retrying', () => {
    expect(readAgentError(apiError(429, 'rate_limit_error', 'slow down')).retryable).toBe(true);
    expect(readAgentError(apiError(529, 'overloaded_error', 'overloaded')).retryable).toBe(true);
    expect(readAgentError(apiError(500, 'api_error', 'boom')).retryable).toBe(true);
  });

  it('passes our own not-configured message straight through', () => {
    const r = readAgentError(
      new Error('ANTHROPIC_API_KEY is not set, so Le Chef is not available.'),
    );
    expect(r.message).toContain('not set');
  });

  it('never leaks the request id or the raw body, whatever the failure', () => {
    const cases = [
      apiError(400, 'invalid_request_error', 'Your credit balance is too low.'),
      apiError(401, 'authentication_error', 'invalid x-api-key'),
      apiError(403, 'permission_error', 'no access'),
      apiError(429, 'rate_limit_error', 'slow down'),
      apiError(500, 'api_error', 'boom'),
      apiError(418, 'weird_error', 'something nobody has seen before'),
      new Error('fetch failed'),
      'a bare string',
    ];
    for (const c of cases) {
      const { message } = readAgentError(c);
      expect(message).not.toContain('request_id');
      expect(message).not.toContain('req_011');
      expect(message).not.toContain('{');
    }
  });

  it('falls back to a plain sentence rather than the raw text', () => {
    const r = readAgentError(apiError(418, 'weird_error', 'something nobody has seen before'));
    expect(r.message).not.toContain('something nobody has seen');
    expect(r.message).toContain('418');
  });
});
