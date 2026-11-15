import {
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  type ImportColumn,
  type ImportField,
  type ImportMapping,
  type ImportPreviewRow,
} from "@/components/contacts/import-fields";
import {
  isValidEmail,
  isValidInstagramHandle,
  normaliseEmail,
  normaliseInstagram,
  phoneDigits,
} from "../_lib/identity";
import { TAG_NAME_MAX } from "../_lib/tags";
import { CsvParseError, isBlankRecord, parseCsv, type CsvRecord } from "./csv";

/** Header spellings (lower-case, letters/digits only) recognised for each field. */
const HEADER_ALIASES: Array<[Exclude<ImportField, "ignore">, string[]]> = [
  ["fullName", ["name", "fullname", "contactname", "customername", "clientname", "displayname"]],
  ["firstName", ["firstname", "first", "givenname", "fname", "forename"]],
  ["lastName", ["lastname", "last", "surname", "familyname", "lname"]],
  ["email", ["email", "emailaddress", "mail", "emailid"]],
  ["phone", ["phone", "phonenumber", "mobile", "mobilenumber", "mobilephone", "cell", "cellphone", "tel", "telephone", "whatsapp", "number"]],
  ["instagram", ["instagram", "ig", "handle", "instagramhandle", "instagramusername", "igusername", "ighandle", "insta", "username", "instagramurl"]],
  ["source", ["source", "leadsource", "origin", "channel"]],
  ["tags", ["tags", "tag", "labels", "label", "segments", "lists"]],
];

function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Guess each column's field from its header. Each field is used once (first column wins). */
export function detectMapping(headers: string[]): ImportColumn[] {
  const used = new Set<ImportField>();
  return headers.map((header, index) => {
    const key = headerKey(header);
    const match = HEADER_ALIASES.find(([field, aliases]) => !used.has(field) && aliases.includes(key));
    const field: ImportField = match ? match[0] : "ignore";
    if (field !== "ignore") used.add(field);
    return { index, header: header.trim(), field };
  });
}

/** Apply a caller's mapping (column index → field) over the detected one. */
export function applyMapping(columns: ImportColumn[], mapping?: ImportMapping | null): ImportColumn[] {
  if (!mapping) return columns;
  return columns.map((col) => {
    const chosen = mapping[String(col.index)];
    return chosen && (IMPORT_FIELDS as readonly string[]).includes(chosen) ? { ...col, field: chosen } : col;
  });
}

export function splitTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[;,|]/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

export type ParsedImport = {
  columns: ImportColumn[];
  rows: ImportPreviewRow[];
};

export class ImportInputError extends Error {}

/**
 * CSV text → columns + validated rows (no database access). Row errors:
 * empty row, invalid email / phone / Instagram handle, no identifying value, values too
 * long, and repeats of an earlier row in the same file.
 */
export function parseImport(csv: string, mapping?: ImportMapping | null): ParsedImport {
  let records: CsvRecord[];
  try {
    records = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvParseError) throw new ImportInputError(error.message);
    throw error;
  }
  const headerIndex = records.findIndex((r) => !isBlankRecord(r));
  if (headerIndex === -1) throw new ImportInputError("The file is empty.");
  const header = records[headerIndex]!;
  const dataRecords = records.slice(headerIndex + 1);
  if (!dataRecords.length) throw new ImportInputError("The file has a header row but no contacts.");
  if (dataRecords.length > IMPORT_MAX_ROWS) {
    throw new ImportInputError(
      `This file has ${dataRecords.length.toLocaleString("en-US")} rows; the limit is ${IMPORT_MAX_ROWS.toLocaleString("en-US")} per import. Split it and import the parts.`,
    );
  }

  const columns = applyMapping(detectMapping(header.cells), mapping);
  const mapped = columns.filter((c) => c.field !== "ignore").map((c) => c.field);
  const hasIdentityColumn = mapped.some((f) =>
    ["fullName", "firstName", "lastName", "email", "phone", "instagram"].includes(f),
  );
  if (!hasIdentityColumn) {
    throw new ImportInputError(
      "No name, email, phone or Instagram column was found. Check the header row or choose the columns.",
    );
  }

  const firstSeen = { email: new Map<string, number>(), phone: new Map<string, number>(), instagram: new Map<string, number>() };

  const rows = dataRecords.map((record): ImportPreviewRow => {
    const cell = (field: ImportField): string => {
      const col = columns.find((c) => c.field === field);
      return col ? (record.cells[col.index] ?? "").trim() : "";
    };
    const errors: string[] = [];
    const blank: ImportPreviewRow["values"] = {
      fullName: null,
      email: null,
      phone: null,
      instagram: null,
      source: null,
      tags: [],
    };
    if (isBlankRecord(record)) {
      return { line: record.line, values: blank, errors: ["Empty row"], match: null };
    }

    const fullName =
      cell("fullName") || [cell("firstName"), cell("lastName")].filter(Boolean).join(" ").trim() || null;
    if (fullName && fullName.length > 200) errors.push("Name is longer than 200 characters");

    const rawEmail = cell("email");
    const email = normaliseEmail(rawEmail);
    if (email && !isValidEmail(email)) errors.push(`Invalid email "${rawEmail}"`);

    const rawPhone = cell("phone");
    if (rawPhone && !phoneDigits(rawPhone)) errors.push(`Invalid phone "${rawPhone}"`);
    if (rawPhone.length > 40) errors.push("Phone is longer than 40 characters");

    const rawInstagram = cell("instagram");
    const instagram = normaliseInstagram(rawInstagram);
    if (instagram && !isValidInstagramHandle(instagram)) errors.push(`Invalid Instagram handle "${rawInstagram}"`);

    const source = cell("source") || null;
    if (source && source.length > 80) errors.push("Source is longer than 80 characters");

    const tags = splitTags(cell("tags"));
    const longTag = tags.find((t) => t.length > TAG_NAME_MAX);
    if (longTag) errors.push(`Tag "${longTag.slice(0, 20)}…" is longer than ${TAG_NAME_MAX} characters`);

    if (!fullName && !email && !rawPhone && !instagram) {
      errors.push("No name, email, phone or Instagram handle");
    }

    // Same person twice in one file: keep the first row.
    const keys = { email, phone: phoneDigits(rawPhone), instagram };
    if (!errors.length) {
      for (const key of ["email", "phone", "instagram"] as const) {
        const value = keys[key];
        const earlier = value ? firstSeen[key].get(value) : undefined;
        if (earlier !== undefined) {
          errors.push(`Same ${key === "instagram" ? "Instagram handle" : key} as line ${earlier}`);
          break;
        }
      }
      if (!errors.length) {
        for (const key of ["email", "phone", "instagram"] as const) {
          const value = keys[key];
          if (value) firstSeen[key].set(value, record.line);
        }
      }
    }

    return {
      line: record.line,
      values: { fullName, email, phone: rawPhone || null, instagram, source, tags },
      errors,
      match: null,
    };
  });

  return { columns, rows };
}
