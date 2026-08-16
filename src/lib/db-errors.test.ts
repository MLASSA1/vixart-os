import { describe, expect, it } from 'vitest';
import { describeDbError, readDbError } from './db-errors';

/**
 * These exist because the bug they cover shipped: every action matched against
 * `error.message`, but Drizzle wraps the driver error as
 * "Failed query: insert into ... params: ...". The constraint name lives on
 * `error.cause`, so no match ever fired and the raw SQL — bound parameters
 * included — was rendered into the interface.
 */

/** Shape of what Drizzle actually throws, driver error nested underneath. */
function drizzleError(pg: Record<string, unknown>) {
  const wrapper = new Error(
    'Failed query: insert into "service_price" ("id", "service_id") values (default, $1) params: 02ef13e7',
  );
  (wrapper as Error & { cause?: unknown }).cause = Object.assign(
    new Error(pg.message as string),
    pg,
  );
  return wrapper;
}

describe('readDbError', () => {
  it('finds the constraint under the Drizzle wrapper', () => {
    const e = drizzleError({
      message: 'duplicate key value violates unique constraint "service_price_version_key"',
      constraint: 'service_price_version_key',
      code: '23505',
    });
    const read = readDbError(e);
    expect(read.constraint).toBe('service_price_version_key');
    expect(read.code).toBe('23505');
    expect(read.message).not.toContain('Failed query');
  });

  it('survives a plain Error with no cause', () => {
    const read = readDbError(new Error('boom'));
    expect(read.message).toBe('boom');
    expect(read.constraint).toBeUndefined();
  });
});

describe('describeDbError', () => {
  it('maps a constraint to a sentence a human can act on', () => {
    const e = drizzleError({
      message: 'duplicate key value violates unique constraint "service_price_version_key"',
      constraint: 'service_price_version_key',
      code: '23505',
    });
    expect(describeDbError(e)).toMatch(/price already starts on that date/i);
  });

  it('lets a module override the shared wording', () => {
    const e = drizzleError({
      message: 'duplicate key',
      constraint: 'service_price_version_key',
      code: '23505',
    });
    expect(describeDbError(e, { service_price_version_key: 'custom text' })).toBe(
      'custom text',
    );
  });

  it('passes our own trigger messages straight through', () => {
    const e = drizzleError({
      message: 'Only a moderator can mark a task completed. Submit it for review instead.',
      code: '42501',
    });
    expect(describeDbError(e)).toMatch(/^Only a moderator/);
  });

  it('never leaks generated SQL or bound parameters', () => {
    const bare = new Error(
      'Failed query: insert into "company" ("id","name") values (default,$1) params: Bader',
    );
    const shown = describeDbError(bare);
    expect(shown).not.toContain('insert into');
    expect(shown).not.toContain('params:');
    expect(shown).toBe('The database refused that change.');
  });

  it('falls back to SQLSTATE when the constraint is unknown', () => {
    const e = drizzleError({ message: 'nope', code: '42501' });
    expect(describeDbError(e)).toBe('You do not have permission for that.');
  });
});
