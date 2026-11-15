/**
 * CSV import column targets — shared by the import API and the import panel.
 */
export const IMPORT_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "instagram",
  "source",
  "tags",
  "ignore",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  instagram: "Instagram handle",
  source: "Source",
  tags: "Tags",
  ignore: "Don't import",
};

export const IMPORT_MAX_ROWS = 2000;
/** ~5 MB of CSV text — far above 2,000 rows of contact data. */
export const IMPORT_MAX_CSV_CHARS = 5_000_000;

/** Column index (as a string) → field. */
export type ImportMapping = Record<string, ImportField>;

export type ImportColumn = { index: number; header: string; field: ImportField };

export type ImportMatch = {
  contactId: string;
  fullName: string | null;
  matchedOn: Array<"email" | "phone" | "instagram">;
  /** The row matches more than one existing contact — it is never updated automatically. */
  ambiguous: boolean;
};

export type ImportPreviewRow = {
  /** Line number in the file (header = 1). */
  line: number;
  values: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    instagram: string | null;
    source: string | null;
    tags: string[];
  };
  errors: string[];
  match: ImportMatch | null;
};

export type ImportPreview = {
  columns: ImportColumn[];
  rows: ImportPreviewRow[];
  totals: { rows: number; valid: number; invalid: number; duplicates: number; new: number };
};

export type ImportCommitResult = {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  tagsCreated: number;
  total: number;
};
