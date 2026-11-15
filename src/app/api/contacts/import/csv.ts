/**
 * Small RFC 4180 CSV reader for contact imports — no dependencies.
 *
 * Handles: a UTF-8 BOM, quoted fields with embedded delimiters / newlines, escaped quotes
 * (""), CRLF / LF / lone CR line endings, and comma, semicolon or tab delimiters (Excel in
 * many European locales saves ";"). Lenient like spreadsheets are: a quote inside an unquoted
 * field is kept as text. An opening quote that never closes is an error, since everything
 * after it would silently collapse into one cell.
 */

export type CsvRecord = {
  /** 1-based line number where the record starts. */
  line: number;
  cells: string[];
};

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "CsvParseError";
  }
}

export type CsvDelimiter = "," | ";" | "\t";

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pick the delimiter that splits the first line (outside quotes) into the most cells. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t")) counts[ch] += 1;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

export function parseCsv(input: string, delimiter?: CsvDelimiter): CsvRecord[] {
  const text = stripBom(input);
  const sep = delimiter ?? detectDelimiter(text);
  const records: CsvRecord[] = [];

  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoteStartLine = 1;
  let line = 1;
  let recordLine = 1;
  /** True once the current record has any content (so a trailing newline adds no record). */
  let recordStarted = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
    recordStarted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.trim() === "") {
      // Opening quote only at the start of a cell (spaces before it are dropped);
      // elsewhere a quote is plain text.
      cell = "";
      inQuotes = true;
      quoteStartLine = line;
      recordStarted = true;
      continue;
    }
    if (ch === sep) {
      recordStarted = true;
      endCell();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (recordStarted || cell !== "" || cells.length) endRecord();
      else records.push({ line: recordLine, cells: [""] }); // blank line — callers decide
      line++;
      recordLine = line;
      continue;
    }
    recordStarted = true;
    cell += ch;
  }

  if (inQuotes) {
    throw new CsvParseError(`The file has a quote that is never closed (line ${quoteStartLine}).`, quoteStartLine);
  }
  if (recordStarted || cell !== "" || cells.length) endRecord();

  // Drop trailing blank lines — they are just the end of the file, not empty rows.
  while (records.length && isBlankRecord(records[records.length - 1]!)) records.pop();
  return records;
}

export function isBlankRecord(record: CsvRecord): boolean {
  return record.cells.every((c) => c.trim() === "");
}
