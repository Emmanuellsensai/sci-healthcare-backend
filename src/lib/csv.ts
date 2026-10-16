/**
 * Minimal RFC 4180 CSV writing, used by the streamed voucher export.
 *
 * Only one cell at a time is escaped and appended, so an export never has
 * to hold the whole document in memory.
 */

/** Escapes one cell: quote it only when it contains a delimiter, quote or line break. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
