import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordCrmActivities } from "@/services/crm-activity";
import {
  IMPORT_FIELDS,
  IMPORT_MAX_CSV_CHARS,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewRow,
} from "@/components/contacts/import-fields";
import { canManageContacts, managerOnlyContactAction } from "@/components/contacts/contact-permissions";
import { errorResponse, HttpError, readJsonBody } from "../_lib/http";
import {
  findLiveContactsByIdentity,
  identityKeys,
  matchFields,
  type IdentityCandidate,
} from "../_lib/identity";
import { ensureTagsByName } from "../_lib/tags";
import { ImportInputError, parseImport } from "./rows";

const INSERT_BATCH = 500;
const UPDATE_CONCURRENCY = 10;

const csvSchema = z
  .string({ required_error: "Choose a CSV file to import.", invalid_type_error: "csv must be the file's text." })
  .max(IMPORT_MAX_CSV_CHARS, "The file is too large (5 MB maximum).");
const mappingSchema = z.record(
  z.string().regex(/^\d+$/, "Mapping keys are column numbers."),
  z.enum(IMPORT_FIELDS, { errorMap: () => ({ message: "Unknown column type in the mapping." }) }),
);

const bodySchema = z.discriminatedUnion(
  "mode",
  [
    z.object({ mode: z.literal("preview"), csv: csvSchema, mapping: mappingSchema.optional().nullable() }),
    z.object({
      mode: z.literal("commit"),
      csv: csvSchema,
      mapping: mappingSchema.optional().nullable(),
      onDuplicate: z.enum(["skip", "update"], {
        errorMap: () => ({ message: 'onDuplicate must be "skip" or "update".' }),
      }),
    }),
  ],
  { errorMap: () => ({ message: 'mode must be "preview" or "commit".' }) },
);

/** Mark rows that match an existing live contact (by email, phone digits or Instagram handle). */
async function attachMatches(organisationId: string, rows: ImportPreviewRow[]): Promise<void> {
  const valid = rows.filter((r) => !r.errors.length);
  const rowKeys = new Map(
    valid.map((r) => [r, identityKeys({ email: r.values.email, phone: r.values.phone, instagramUsername: r.values.instagram })]),
  );
  const keys = [...rowKeys.values()];
  const candidates = await findLiveContactsByIdentity(prisma, {
    organisationId,
    emails: keys.flatMap((k) => (k.email ? [k.email] : [])),
    phones: keys.flatMap((k) => (k.phone ? [k.phone] : [])),
    handles: keys.flatMap((k) => (k.instagram ? [k.instagram] : [])),
  });
  if (!candidates.length) return;

  const index = { email: new Map<string, IdentityCandidate[]>(), phone: new Map<string, IdentityCandidate[]>(), instagram: new Map<string, IdentityCandidate[]>() };
  for (const candidate of candidates) {
    const k = identityKeys(candidate);
    for (const field of ["email", "phone", "instagram"] as const) {
      const value = k[field];
      if (value) index[field].set(value, [...(index[field].get(value) ?? []), candidate]);
    }
  }

  for (const [row, k] of rowKeys) {
    const found = new Map<string, IdentityCandidate>();
    for (const field of ["email", "instagram", "phone"] as const) {
      const value = k[field];
      for (const c of value ? (index[field].get(value) ?? []) : []) if (!found.has(c.id)) found.set(c.id, c);
    }
    const first = found.values().next().value;
    if (!first) continue;
    row.match = {
      contactId: first.id,
      fullName: first.fullName,
      matchedOn: matchFields(k, identityKeys(first)),
      ambiguous: found.size > 1,
    };
  }
}

function previewTotals(rows: ImportPreviewRow[]): ImportPreview["totals"] {
  const valid = rows.filter((r) => !r.errors.length);
  const duplicates = valid.filter((r) => r.match).length;
  return {
    rows: rows.length,
    valid: valid.length,
    invalid: rows.length - valid.length,
    duplicates,
    new: valid.length - duplicates,
  };
}

/**
 * POST /api/contacts/import
 *  { mode: "preview", csv, mapping? } → columns (detected mapping), rows with per-row errors and
 *    matches against existing live contacts, totals. Nothing is written.
 *  { mode: "commit", csv, mapping?, onDuplicate: "skip" | "update" } → creates new contacts in
 *    batches (leadSource "csv_import"), updates or skips matched ones, creates missing tags, and
 *    returns counts. Rows with errors are never imported.
 * `mapping` is { [columnIndex]: field } and overrides the detected mapping per column.
 * onDuplicate "update" needs leads:write AND pipeline:manage (Owner / Administrator / Manager).
 * Max 2,000 data rows per file.
 */
export async function POST(req: Request) {
  try {
    const raw = await readJsonBody(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = bodySchema.parse(raw);
    // Importing new contacts (skip) is everyday work; overwriting existing ones is not.
    if (body.mode === "commit" && body.onDuplicate === "update" && !canManageContacts(session.role)) {
      throw new HttpError(403, managerOnlyContactAction("updating existing contacts from a CSV import"));
    }
    const organisationId = session.organisationId;

    let parsed: ReturnType<typeof parseImport>;
    try {
      parsed = parseImport(body.csv, body.mapping);
    } catch (error) {
      if (error instanceof ImportInputError) throw new HttpError(400, error.message);
      throw error;
    }
    await attachMatches(organisationId, parsed.rows);

    if (body.mode === "preview") {
      const preview: ImportPreview = { ...parsed, totals: previewTotals(parsed.rows) };
      return Response.json(preview);
    }

    const valid = parsed.rows.filter((r) => !r.errors.length);
    const toCreate = valid.filter((r) => !r.match);
    const toUpdate: ImportPreviewRow[] = [];
    let skipped = 0;
    const updating = new Set<string>();
    for (const row of valid) {
      if (!row.match) continue;
      // Ambiguous rows (match several contacts) and a second row for the same contact are skipped.
      if (body.onDuplicate === "update" && !row.match.ambiguous && !updating.has(row.match.contactId)) {
        updating.add(row.match.contactId);
        toUpdate.push(row);
      } else {
        skipped += 1;
      }
    }

    const { idsByLowerName, created: tagsCreated } = await ensureTagsByName(
      organisationId,
      [...toCreate, ...toUpdate].flatMap((r) => r.values.tags),
    );
    const tagLinks = (contactId: string, row: ImportPreviewRow) =>
      row.values.tags.flatMap((name) => {
        const tagId = idsByLowerName.get(name.toLowerCase());
        return tagId ? [{ contactId, tagId }] : [];
      });

    const importedAt = new Date();
    const created = await prisma.$transaction(
      async (tx) => {
        const out: Array<{ id: string; row: ImportPreviewRow }> = [];
        for (let i = 0; i < toCreate.length; i += INSERT_BATCH) {
          const batch = toCreate.slice(i, i + INSERT_BATCH);
          const byLine = new Map(batch.map((r) => [r.line, r]));
          const inserted = await tx.contact.createManyAndReturn({
            data: batch.map((r) => ({
              organisationId,
              fullName: r.values.fullName,
              email: r.values.email,
              phone: r.values.phone,
              instagramUsername: r.values.instagram,
              leadSource: "csv_import",
              campaignSource: r.values.source,
              lastContactAt: importedAt,
              metadata: {
                provenance: "csv_import",
                importLine: r.line,
                importedAt: importedAt.toISOString(),
                importedByUserId: session.userId,
              } as Prisma.InputJsonValue,
            })),
            select: { id: true, metadata: true },
          });
          for (const contact of inserted) {
            const line = (contact.metadata as { importLine?: number } | null)?.importLine;
            const row = line !== undefined ? byLine.get(line) : undefined;
            if (row) out.push({ id: contact.id, row });
          }
        }
        const links = out.flatMap(({ id, row }) => tagLinks(id, row));
        if (links.length) await tx.contactTag.createMany({ data: links, skipDuplicates: true });
        return out;
      },
      { timeout: 60_000 },
    );

    let updated = 0;
    for (let i = 0; i < toUpdate.length; i += UPDATE_CONCURRENCY) {
      const counts = await Promise.all(
        toUpdate.slice(i, i + UPDATE_CONCURRENCY).map(async (row) => {
          const { count } = await prisma.contact.updateMany({
            where: { id: row.match!.contactId, organisationId, deletedAt: null },
            data: {
              fullName: row.values.fullName ?? undefined,
              email: row.values.email ?? undefined,
              phone: row.values.phone ?? undefined,
              instagramUsername: row.values.instagram ?? undefined,
            },
          });
          return count;
        }),
      );
      updated += counts.reduce((a, b) => a + b, 0);
    }
    const updateLinks = toUpdate.flatMap((row) => tagLinks(row.match!.contactId, row));
    if (updateLinks.length) await prisma.contactTag.createMany({ data: updateLinks, skipDuplicates: true });

    await recordCrmActivities(
      created.map(({ id, row }) => ({
        organisationId,
        kind: "imported" as const,
        title: "Imported from CSV",
        contactId: id,
        createdByUserId: session.userId,
        metadata: { line: row.line, source: row.values.source, tags: row.values.tags },
      })),
    );

    const result: ImportCommitResult = {
      created: created.length,
      updated,
      skipped,
      invalid: parsed.rows.length - valid.length,
      tagsCreated,
      total: parsed.rows.length,
    };
    await writeAuditLog({
      organisationId,
      userId: session.userId,
      action: "contacts.import.csv",
      entityType: "Contact",
      entityId: organisationId,
      metadata: { ...result, onDuplicate: body.onDuplicate },
    }).catch(() => undefined);

    return Response.json(result);
  } catch (error) {
    return errorResponse(error, "The import");
  }
}
