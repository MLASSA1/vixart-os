/**
 * VIXART OS — CSV export.
 *
 * Two things make the difference between a file that opens and one that does
 * not, on the machines this has to work on:
 *
 *  1. A UTF-8 BOM. Without it, Excel on Windows reads the file as the local
 *     ANSI codepage and "Laboratoire Talborjt" becomes mojibake.
 *  2. A semicolon separator. Excel follows the system list separator, which is
 *     `;` on French and Moroccan locales — with commas the whole row lands in
 *     one cell.
 *
 * Amounts are written as plain decimals (1234.56), not the display format:
 * a spreadsheet has to be able to sum the column.
 */

const BOM = '﻿';
const SEP = ';';

/** Quotes a field, and neutralises anything a spreadsheet would run as a formula. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);

  // A cell starting with = + - @ is executed as a formula by Excel and Sheets.
  // Prefixing with an apostrophe keeps it as text — CSV injection is a real
  // attack when the data came from outside.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (text.includes('"') || text.includes(SEP) || /[\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const lines = [headers.map(cell).join(SEP)];
  for (const row of rows) lines.push(row.map(cell).join(SEP));
  // CRLF: what Excel expects.
  return BOM + lines.join('\r\n') + '\r\n';
}

/** `Content-Disposition` and friends for a CSV download. */
export function csvHeaders(filename: string): HeadersInit {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  };
}
