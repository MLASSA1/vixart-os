import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('starts with a UTF-8 BOM so Excel reads accents correctly', () => {
    const csv = toCsv(['Name'], [['Laboratoire Talborjt']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Laboratoire Talborjt');
  });

  it('separates with semicolons, as French and Moroccan Excel expects', () => {
    const csv = toCsv(['A', 'B'], [['one', 'two']]);
    expect(csv).toContain('A;B');
    expect(csv).toContain('one;two');
  });

  it('quotes a field containing the separator', () => {
    const csv = toCsv(['A'], [['Agadir; Morocco']]);
    expect(csv).toContain('"Agadir; Morocco"');
  });

  it('doubles embedded quotes', () => {
    const csv = toCsv(['A'], [['He said "yes"']]);
    expect(csv).toContain('"He said ""yes"""');
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    // CSV injection: =HYPERLINK(...) in a contact name would execute on open.
    const csv = toCsv(['Name'], [['=HYPERLINK("http://evil","click")']]);
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/(^|;)=HYPERLINK/m);
  });

  it('handles an empty cell without inventing one', () => {
    const csv = toCsv(['A', 'B'], [[null, undefined]]);
    expect(csv).toContain('\r\n;\r\n');
  });

  it('ends every line with CRLF', () => {
    const csv = toCsv(['A'], [['x']]);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
