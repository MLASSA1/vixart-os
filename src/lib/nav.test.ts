import { describe, expect, it } from 'vitest';
import { NAV, whereAmI } from './nav';

/**
 * The trail above every page title ("Relationships › Directory") is derived
 * from the sidebar's own map. These pin how a path is placed in it, because
 * the trail is the answer to "where am I?" on every screen, and a wrong
 * answer there is worse than none.
 */

describe('whereAmI places a path in the sidebar map', () => {
  it('puts every sidebar entry on its own page, not inside anything', () => {
    for (const item of NAV) {
      const here = whereAmI(item.href);
      expect(here?.item.href, item.href).toBe(item.href);
      expect(here?.inside, item.href).toBe(false);
    }
  });

  it('puts a record inside the list it belongs to', () => {
    const here = whereAmI('/companies/f45eafef-14be-4162-af70-be7f76d70b71');
    expect(here?.item.label).toBe('Directory');
    expect(here?.group).toBe('Relationships');
    expect(here?.inside).toBe(true);
  });

  it('prefers the longest matching entry', () => {
    // /documents/new belongs to Quotes & invoices, and an edit page to its record's list.
    expect(whereAmI('/documents/new')?.item.label).toBe('Quotes & invoices');
    expect(whereAmI('/companies/abc/edit')?.item.label).toBe('Directory');
  });

  it('does not mistake a shared prefix for a parent', () => {
    // "/clients-archive" is not inside "/clients": only a slash makes a child.
    expect(whereAmI('/clients-archive')).toBeNull();
  });

  it('answers null for a page the sidebar does not list', () => {
    expect(whereAmI('/account')).toBeNull();
    expect(whereAmI('/')).toBeNull();
  });

  it('gives a top-level entry no group, so the trail stays empty there', () => {
    expect(whereAmI('/chat')?.group).toBeNull();
    expect(whereAmI('/tasks')?.group).toBe('Team space');
  });
});
