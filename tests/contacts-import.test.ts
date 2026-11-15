import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CsvParseError, detectDelimiter, parseCsv } from "@/app/api/contacts/import/csv";
import { detectMapping, ImportInputError, parseImport, splitTags } from "@/app/api/contacts/import/rows";
import { normaliseInstagram, phoneDigits } from "@/app/api/contacts/_lib/identity";

/** CSV import: the parser, column detection, row validation, and the preview/commit route. */

const prismaMocks = vi.hoisted(() => {
  const m = {
    contact: {
      createManyAndReturn: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    tag: { findMany: vi.fn(async () => [] as unknown[]), createMany: vi.fn(async () => ({ count: 0 })) },
    contactTag: { createMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => [] as unknown[]),
    $transaction: vi.fn(),
  };
  return m;
});

const sessionState = vi.hoisted(() => ({ deny: null as string | null, role: "SALES_AGENT" }));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/crm-activity", () => ({
  recordCrmActivity: vi.fn(async () => undefined),
  recordCrmActivities: vi.fn(async () => undefined),
}));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const guard = async () => {
    if (sessionState.deny) throw new Error(`Forbidden: missing permission ${sessionState.deny}`);
    return { userId: "user_1", organisationId: "org_1", role: sessionState.role };
  };
  return {
    requireSession: vi.fn(guard),
    requirePermission: vi.fn(guard),
    requirePermissionForMutation: vi.fn(guard),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

import { recordCrmActivities } from "@/services/crm-activity";

describe("parseCsv", () => {
  it("handles quoted fields with delimiters, escaped quotes and embedded newlines", () => {
    const records = parseCsv('name,notes\n"Lovelace, Ada","She said ""hi""\nthen left"\nBob,plain\n');
    expect(records.map((r) => r.cells)).toEqual([
      ["name", "notes"],
      ["Lovelace, Ada", 'She said "hi"\nthen left'],
      ["Bob", "plain"],
    ]);
    // Line numbers follow the file, even across a multi-line cell.
    expect(records.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it("strips a BOM and accepts CRLF and lone CR line endings", () => {
    expect(parseCsv("﻿name,email\r\nAda,a@x.test\r\n").map((r) => r.cells)).toEqual([
      ["name", "email"],
      ["Ada", "a@x.test"],
    ]);
    expect(parseCsv("a,b\rc,d").map((r) => r.cells)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps empty cells and interior blank lines, drops trailing blank lines", () => {
    const records = parseCsv("a,b,c\n1,,3\n\n4,5,\n\n\n");
    expect(records.map((r) => r.cells)).toEqual([["a", "b", "c"], ["1", "", "3"], [""], ["4", "5", ""]]);
  });

  it("detects semicolon and tab delimiters (Excel exports)", () => {
    expect(detectDelimiter('name;email;"x,y"\n')).toBe(";");
    expect(detectDelimiter("name\temail\n")).toBe("\t");
    expect(parseCsv("name;email\nAda;a@x.test").map((r) => r.cells)[1]).toEqual(["Ada", "a@x.test"]);
  });

  it("treats a stray quote inside a value as text but rejects an unclosed quoted field", () => {
    expect(parseCsv('a,b\n5" screen,ok').map((r) => r.cells)[1]).toEqual(['5" screen', "ok"]);
    expect(() => parseCsv('a,b\n"never closed,1\n2,3')).toThrow(CsvParseError);
  });
});

describe("column detection and row validation", () => {
  it("recognises common header spellings", () => {
    const cols = detectMapping(["Full Name", "E-mail", "Phone Number", "IG", "Lead Source", "Tags", "Notes"]);
    expect(cols.map((c) => c.field)).toEqual(["fullName", "email", "phone", "instagram", "source", "tags", "ignore"]);
    expect(detectMapping(["First name", "Last name", "Handle"]).map((c) => c.field)).toEqual([
      "firstName",
      "lastName",
      "instagram",
    ]);
    // A field is mapped once; a second "email" column is ignored.
    expect(detectMapping(["email", "Email address"]).map((c) => c.field)).toEqual(["email", "ignore"]);
  });

  it("normalises Instagram handles and phone numbers", () => {
    expect(normaliseInstagram("@Ada.Shop")).toBe("ada.shop");
    expect(normaliseInstagram("https://www.instagram.com/ada.shop/?hl=en")).toBe("ada.shop");
    expect(phoneDigits("+1 (555) 010-2000")).toBe("15550102000");
    expect(phoneDigits("12-34")).toBeNull();
    expect(splitTags("VIP; wholesale, vip | Spring")).toEqual(["VIP", "wholesale", "Spring"]);
  });

  it("flags bad emails, empty rows, rows without identity and in-file repeats", () => {
    const { rows } = parseImport(
      [
        "First,Last,Email,Phone,Instagram,Tags",
        "Ada,Lovelace,ADA@X.test,,@ada,VIP;Hot",
        "Bad,Email,not-an-email,,,",
        ",,,,,",
        ",,,,,VIP",
        "Again,Ada,ada@x.test,,,",
        "Short,Phone,,123,,",
        "Bad,Handle,,,ada shop!,",
      ].join("\n"),
    );
    expect(rows[0]).toMatchObject({
      line: 2,
      errors: [],
      values: { fullName: "Ada Lovelace", email: "ada@x.test", instagram: "ada", tags: ["VIP", "Hot"] },
    });
    expect(rows[1]!.errors[0]).toMatch(/Invalid email/);
    expect(rows[2]!.errors).toEqual(["Empty row"]);
    expect(rows[3]!.errors).toEqual(["No name, email, phone or Instagram handle"]);
    expect(rows[4]!.errors).toEqual(["Same email as line 2"]);
    expect(rows[5]!.errors[0]).toMatch(/Invalid phone/);
    expect(rows[6]!.errors[0]).toMatch(/Invalid Instagram handle/);
  });

  it("applies a caller mapping over the detected one", () => {
    const { columns, rows } = parseImport("Who,Contact\nAda,ada@x.test", { "0": "fullName", "1": "email" });
    expect(columns.map((c) => c.field)).toEqual(["fullName", "email"]);
    expect(rows[0]!.values).toMatchObject({ fullName: "Ada", email: "ada@x.test" });
  });

  it("rejects empty files, header-only files, unmapped files and more than 2,000 rows", () => {
    expect(() => parseImport("")).toThrow(ImportInputError);
    expect(() => parseImport("name,email\n")).toThrow(/no contacts/);
    expect(() => parseImport("colour,size\nred,M")).toThrow(/No name, email, phone or Instagram column/);
    const big = ["email", ...Array.from({ length: 2001 }, (_, i) => `p${i}@x.test`)].join("\n");
    expect(() => parseImport(big)).toThrow(/limit is 2,000/);
  });
});

describe("POST /api/contacts/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.deny = null;
    sessionState.role = "SALES_AGENT";
    prismaMocks.$transaction.mockImplementation(async (cb: (tx: typeof prismaMocks) => unknown) => cb(prismaMocks));
    prismaMocks.$queryRaw.mockResolvedValue([]);
    prismaMocks.contact.createManyAndReturn.mockImplementation(
      async (args: { data: Array<{ metadata: { importLine: number } }> }) =>
        args.data.map((d, i) => ({ id: `new_${i + 1}`, metadata: d.metadata })),
    );
  });

  async function post(body: unknown) {
    const { POST } = await import("@/app/api/contacts/import/route");
    return POST(new Request("http://localhost/api/contacts/import", { method: "POST", body: JSON.stringify(body) }));
  }

  const CSV = [
    "Name,Email,Phone,IG,Tags,Source",
    "Ada Lovelace,ada@x.test,,@ada,VIP,Fair 2026",
    "Existing Person,EXISTING@x.test,,,,",
    "No Email,bad-email,,,,",
    "Grace Hopper,,+1 555 010 2000,,VIP;New tag,",
  ].join("\n");

  it("preview returns the mapping, row errors and matches against live contacts — and writes nothing", async () => {
    prismaMocks.$queryRaw.mockResolvedValueOnce([
      { id: "c_existing", fullName: "Existing P.", email: "existing@x.test", phone: null, instagramUsername: null },
    ]);
    const res = await post({ mode: "preview", csv: CSV });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.columns.map((c: { field: string }) => c.field)).toEqual([
      "fullName",
      "email",
      "phone",
      "instagram",
      "tags",
      "source",
    ]);
    expect(body.totals).toEqual({ rows: 4, valid: 3, invalid: 1, duplicates: 1, new: 2 });
    expect(body.rows[1].match).toEqual({
      contactId: "c_existing",
      fullName: "Existing P.",
      matchedOn: ["email"],
      ambiguous: false,
    });
    expect(body.rows[2].errors[0]).toMatch(/Invalid email/);

    // One matching query, scoped to the caller's workspace and live contacts, normalised keys.
    const sql = prismaMocks.$queryRaw.mock.calls[0]![0] as unknown as Prisma.Sql;
    expect(sql.values).toContain("org_1");
    expect(sql.sql).toContain('"deletedAt" IS NULL');
    expect(sql.values).toContainEqual(["ada@x.test", "existing@x.test"]);
    expect(sql.values).toContainEqual(["15550102000"]);
    expect(sql.values).toContainEqual(["ada"]);

    expect(prismaMocks.contact.createManyAndReturn).not.toHaveBeenCalled();
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.tag.createMany).not.toHaveBeenCalled();
  });

  it("commit with skip creates only new rows (csv_import), creates tags on the fly and records one 'imported' activity each", async () => {
    prismaMocks.$queryRaw.mockResolvedValueOnce([
      { id: "c_existing", fullName: "Existing", email: "existing@x.test", phone: null, instagramUsername: null },
    ]);
    // First lookup: only VIP exists; after createMany both exist.
    prismaMocks.tag.findMany
      .mockResolvedValueOnce([{ id: "t_vip", name: "vip" }])
      .mockResolvedValueOnce([
        { id: "t_vip", name: "vip" },
        { id: "t_new", name: "New tag" },
      ]);
    prismaMocks.tag.createMany.mockResolvedValueOnce({ count: 1 });

    const res = await post({ mode: "commit", csv: CSV, onDuplicate: "skip" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, updated: 0, skipped: 1, invalid: 1, tagsCreated: 1, total: 4 });

    expect(prismaMocks.tag.findMany.mock.calls[0]![0]).toEqual({
      where: { organisationId: "org_1" },
      select: { id: true, name: true },
    });
    expect((prismaMocks.tag.createMany.mock.calls[0]![0] as { data: unknown[] }).data).toEqual([
      { organisationId: "org_1", name: "New tag", color: "#64748b" },
    ]);
    const data = (prismaMocks.contact.createManyAndReturn.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      organisationId: "org_1",
      fullName: "Ada Lovelace",
      email: "ada@x.test",
      instagramUsername: "ada",
      leadSource: "csv_import",
      campaignSource: "Fair 2026",
    });
    expect(data[1]).toMatchObject({ fullName: "Grace Hopper", phone: "+1 555 010 2000", leadSource: "csv_import" });
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();

    expect((prismaMocks.contactTag.createMany.mock.calls[0]![0] as { data: unknown[] }).data).toEqual([
      { contactId: "new_1", tagId: "t_vip" },
      { contactId: "new_2", tagId: "t_vip" },
      { contactId: "new_2", tagId: "t_new" },
    ]);
    const activities = (recordCrmActivities as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Array<{
      kind: string;
      contactId: string;
    }>;
    expect(activities.map((a) => [a.kind, a.contactId])).toEqual([
      ["imported", "new_1"],
      ["imported", "new_2"],
    ]);
  });

  it("commit with update updates the matched contact inside this workspace only", async () => {
    sessionState.role = "MANAGER";
    prismaMocks.$queryRaw.mockResolvedValueOnce([
      { id: "c_existing", fullName: "Existing", email: "existing@x.test", phone: null, instagramUsername: null },
    ]);
    const res = await post({ mode: "commit", csv: CSV, onDuplicate: "update" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: 2, updated: 1, skipped: 0 });
    expect(prismaMocks.contact.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: "c_existing", organisationId: "org_1", deletedAt: null },
      data: { fullName: "Existing Person", email: "existing@x.test", phone: undefined, instagramUsername: undefined },
    });
  });

  it("updating existing contacts needs pipeline:manage too; sales agents can still import new ones", async () => {
    prismaMocks.$queryRaw.mockResolvedValue([
      { id: "c_existing", fullName: "Existing", email: "existing@x.test", phone: null, instagramUsername: null },
    ]);
    const denied = await post({ mode: "commit", csv: CSV, onDuplicate: "update" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/Owner, Administrator or Manager/);
    expect(prismaMocks.contact.createManyAndReturn).not.toHaveBeenCalled();
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();

    const skip = await post({ mode: "commit", csv: CSV, onDuplicate: "skip" });
    expect(skip.status).toBe(200);
    expect(await skip.json()).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();
  });

  it("never auto-updates a row that matches several contacts", async () => {
    sessionState.role = "OWNER";
    prismaMocks.$queryRaw.mockResolvedValueOnce([
      { id: "c_a", fullName: "A", email: "existing@x.test", phone: null, instagramUsername: null },
      { id: "c_b", fullName: "B", email: "EXISTING@x.test ", phone: null, instagramUsername: null },
    ]);
    const res = await post({ mode: "commit", csv: CSV, onDuplicate: "update" });
    expect(await res.json()).toMatchObject({ updated: 0, skipped: 1 });
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();
  });

  it("400s with readable messages for bad input", async () => {
    const bad = async (body: unknown) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      return (await res.json()).error as string;
    };
    expect(await bad({ mode: "upload", csv: CSV })).toMatch(/mode must be/);
    expect(await bad({ mode: "commit", csv: CSV, onDuplicate: "merge" })).toMatch(/onDuplicate/);
    expect(await bad({ mode: "preview" })).toMatch(/Choose a CSV file/);
    expect(await bad({ mode: "preview", csv: 'name\n"oops' })).toMatch(/never closed/);
    expect(await bad({ mode: "preview", csv: CSV, mapping: { "0": "nickname" } })).toMatch(/Unknown column type/);
  });

  it("403 without leads:write", async () => {
    sessionState.deny = "leads:write";
    const res = await post({ mode: "preview", csv: CSV });
    expect(res.status).toBe(403);
    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
  });
});
