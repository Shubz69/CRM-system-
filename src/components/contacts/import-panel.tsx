"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { errorText, sendJson } from "./contacts-api";
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  IMPORT_MAX_CSV_CHARS,
  IMPORT_MAX_ROWS,
  type ImportCommitResult,
  type ImportField,
  type ImportMapping,
  type ImportPreview,
  type ImportPreviewRow,
} from "./import-fields";

type Filter = "all" | "errors" | "duplicates" | "new";
const MAX_SHOWN = 200;

function rowStatus(row: ImportPreviewRow): Exclude<Filter, "all"> {
  if (row.errors.length) return "errors";
  return row.match ? "duplicates" : "new";
}

const MATCH_LABEL = { email: "email", phone: "phone", instagram: "Instagram" } as const;

/**
 * CSV import flow: choose a file → preview (detected columns, per-row errors, matches with
 * existing contacts) → choose skip/update for matches → import → summary.
 */
export function ImportPanel({
  onImported,
  canUpdateExisting,
}: {
  onImported: () => void;
  /** May overwrite matched contacts (onDuplicate "update") — Owner / Administrator / Manager. */
  canUpdateExisting: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
  const [filter, setFilter] = useState<Filter>("all");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  async function runPreview(text: string, nextMapping: ImportMapping | null) {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const json = await sendJson<ImportPreview>("/api/contacts/import", "POST", {
        mode: "preview",
        csv: text,
        ...(nextMapping ? { mapping: nextMapping } : {}),
      });
      setPreview(json);
      setMapping(Object.fromEntries(json.columns.map((c) => [String(c.index), c.field])));
    } catch (error) {
      setPreview(null);
      setPreviewError(errorText(error, "Could not read the file"));
    } finally {
      setPreviewing(false);
    }
  }

  async function onFile(file: File | undefined) {
    setResult(null);
    setPreview(null);
    setPreviewError(null);
    setMapping(null);
    setFilter("all");
    if (!file) return;
    setFileName(file.name);
    if (file.size > IMPORT_MAX_CSV_CHARS) {
      setCsv(null);
      setPreviewError("The file is too large (5 MB maximum).");
      return;
    }
    try {
      const text = await file.text();
      setCsv(text);
      await runPreview(text, null);
    } catch {
      setPreviewError("Could not read that file. Save it as CSV (UTF-8) and try again.");
    }
  }

  function changeColumn(index: number, field: ImportField) {
    if (!csv) return;
    const next: ImportMapping = { ...(mapping ?? {}), [String(index)]: field };
    // One column per field (except "ignore"): picking a field elsewhere clears the old one.
    if (field !== "ignore") {
      for (const [key, value] of Object.entries(next)) {
        if (key !== String(index) && value === field) next[key] = "ignore";
      }
    }
    setMapping(next);
    void runPreview(csv, next);
  }

  async function commit() {
    if (!csv || importing) return;
    setImporting(true);
    try {
      const json = await sendJson<ImportCommitResult>("/api/contacts/import", "POST", {
        mode: "commit",
        csv,
        mapping,
        onDuplicate,
      });
      setResult(json);
      toast.success(`Imported ${json.created.toLocaleString()} new contact${json.created === 1 ? "" : "s"}`);
      onImported();
    } catch (error) {
      toast.error(errorText(error, "Import failed"));
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setFileName(null);
    setCsv(null);
    setPreview(null);
    setMapping(null);
    setPreviewError(null);
    setResult(null);
    setFilter("all");
    if (fileRef.current) fileRef.current.value = "";
  }

  const filtered = useMemo(
    () => (preview?.rows ?? []).filter((r) => filter === "all" || rowStatus(r) === filter),
    [preview, filter],
  );
  const totals = preview?.totals;
  const updatable = useMemo(
    () => (preview?.rows ?? []).filter((r) => !r.errors.length && r.match && !r.match.ambiguous).length,
    [preview],
  );
  const willImport = totals ? totals.new + (onDuplicate === "update" ? updatable : 0) : 0;

  if (result) {
    return (
      <div className="space-y-4">
        <div className="surface-insight rounded-xl p-4">
          <p className="font-semibold">Import finished</p>
          <ul className="mt-2 space-y-1 text-sm">
            <li>{result.created.toLocaleString()} new contacts created</li>
            <li>{result.updated.toLocaleString()} existing contacts updated</li>
            <li>{result.skipped.toLocaleString()} matches skipped</li>
            <li>{result.invalid.toLocaleString()} rows with errors not imported</li>
            {result.tagsCreated ? <li>{result.tagsCreated.toLocaleString()} new tags created</li> : null}
          </ul>
        </div>
        <button type="button" className="btn btn-secondary" onClick={reset}>
          Import another file
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium">
          CSV file
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,.txt"
            className="input mt-1 w-full text-sm"
            disabled={previewing || importing}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>
        <p className="meta mt-1">
          Up to {IMPORT_MAX_ROWS.toLocaleString()} rows. Columns we recognise: name (or first + last name), email,
          phone, Instagram / IG / handle, source, tags (separated by ; or ,).
        </p>
      </div>

      {previewing ? <p className="text-sm text-[var(--muted)]">Reading {fileName ?? "file"}…</p> : null}
      {previewError ? (
        <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--danger)]" role="alert">
          {previewError}
        </p>
      ) : null}

      {preview && totals ? (
        <>
          <section>
            <h3 className="caption">Columns</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {preview.columns.map((col) => (
                <label key={col.index} className="flex items-center gap-2 text-sm">
                  <span className="w-28 truncate font-medium" title={col.header}>
                    {col.header || `Column ${col.index + 1}`}
                  </span>
                  <select
                    className="input py-1 text-sm"
                    value={col.field}
                    disabled={previewing || importing}
                    onChange={(e) => changeColumn(col.index, e.target.value as ImportField)}
                  >
                    {IMPORT_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {IMPORT_FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>

          <div className="filter-bar" role="tablist" aria-label="Filter rows">
            {(
              [
                ["all", `All ${totals.rows}`],
                ["new", `New ${totals.new}`],
                ["duplicates", `Matches ${totals.duplicates}`],
                ["errors", `Errors ${totals.invalid}`],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? "btn btn-primary px-3 py-1 text-xs" : "btn btn-secondary px-3 py-1 text-xs"}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-80 overflow-auto rounded-xl border border-[var(--border)]">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Name</th>
                  <th>Email · phone · Instagram</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, MAX_SHOWN).map((row) => {
                  const status = rowStatus(row);
                  return (
                    <tr
                      key={row.line}
                      className={
                        status === "errors"
                          ? "bg-[color-mix(in_oklab,var(--danger)_7%,white)]"
                          : status === "duplicates"
                            ? "bg-[var(--warn-soft)]"
                            : undefined
                      }
                    >
                      <td>{row.line}</td>
                      <td>
                        {row.values.fullName || "—"}
                        {row.values.tags.length ? <div className="meta">{row.values.tags.join(", ")}</div> : null}
                      </td>
                      <td className="break-all">
                        {row.values.email || "—"}
                        <div className="meta">
                          {[row.values.phone, row.values.instagram ? `@${row.values.instagram}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </td>
                      <td>
                        {status === "errors" ? (
                          <span className="text-[var(--danger)]">{row.errors.join("; ")}</span>
                        ) : status === "duplicates" && row.match ? (
                          <span>
                            <span className="badge badge-warn">
                              {row.match.ambiguous ? "Matches several" : "Matches"}
                            </span>{" "}
                            {row.match.fullName || "existing contact"} (
                            {row.match.matchedOn.map((m) => MATCH_LABEL[m]).join(", ")})
                          </span>
                        ) : (
                          <span className="badge badge-success">New</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!filtered.length ? (
                  <tr>
                    <td colSpan={4} className="text-[var(--muted)]">
                      No rows here.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {filtered.length > MAX_SHOWN ? (
            <p className="meta">
              Showing the first {MAX_SHOWN} of {filtered.length.toLocaleString()} rows.
            </p>
          ) : null}

          {totals.duplicates > 0 ? (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium">
                {totals.duplicates.toLocaleString()} row{totals.duplicates === 1 ? "" : "s"} match existing contacts
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="on-duplicate"
                  checked={onDuplicate === "skip"}
                  onChange={() => setOnDuplicate("skip")}
                />
                Skip them — leave existing contacts unchanged
              </label>
              <label className={`flex items-center gap-2 ${canUpdateExisting ? "" : "opacity-60"}`}>
                <input
                  type="radio"
                  name="on-duplicate"
                  checked={onDuplicate === "update"}
                  disabled={!canUpdateExisting}
                  onChange={() => setOnDuplicate("update")}
                />
                Update them with the file&apos;s name, email, phone, Instagram and tags
              </label>
              <p className="meta">
                Rows matching more than one contact are always skipped.
                {canUpdateExisting ? null : " Only owners, administrators and managers can update existing contacts."}
              </p>
            </fieldset>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={importing || previewing || willImport === 0}
              onClick={() => void commit()}
            >
              {importing
                ? "Importing…"
                : `Import ${willImport.toLocaleString()} contact${willImport === 1 ? "" : "s"}`}
            </button>
            {totals.invalid ? (
              <span className="meta">
                {totals.invalid.toLocaleString()} row{totals.invalid === 1 ? "" : "s"} with errors will be skipped.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
