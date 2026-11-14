/**
 * CSV cell escaping that is safe to open in Excel / Sheets / Numbers.
 *
 * Values that start with = + - @ (or a tab / carriage return) are executed as formulas
 * by spreadsheet apps. Contact names come from Instagram profiles, so a lead could name
 * themselves `=HYPERLINK("https://evil.example","Click")` and have it run on export.
 * Such cells are prefixed with a single quote, then quoted as usual.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  // Real numbers (e.g. a negative score) are data, not formulas.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: Array<string | number | boolean | null | undefined>): string {
  return values.map(csvCell).join(",");
}
