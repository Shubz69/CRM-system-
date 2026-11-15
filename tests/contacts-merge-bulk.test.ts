import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Duplicates, merge and bulk actions on contacts. */

const MOVED_MODELS = [
  "conversation",
  "lead",
  "deal",
  "note",
  "booking",
  "followUp",
  "attribution",
  "contactSuppression",
  "crmActivity",
  "contactIdentifier",
  "socialProspect",
  "socialOutreachThread",
  "outboundDispatch",
] as const;

const prismaMocks = vi.hoisted(() => {
  const updateMany = () => vi.fn(async () => ({ count: 2 }));
  const m = {
    contact: {
      findFirst: vi.fn(async () => null as unknown),
      findMany: vi.fn(async () => [] as unknown[]),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    conversation: { updateMany: updateMany(), findMany: vi.fn(async () => [] as unknown[]) },
    lead: {
      updateMany: updateMany(),
      findMany: vi.fn(async () => [] as unknown[]),
      createManyAndReturn: vi.fn(async () => [] as unknown[]),
    },
    deal: { updateMany: updateMany() },
    note: { updateMany: updateMany() },
    booking: { updateMany: updateMany() },
    followUp: { updateMany: updateMany() },
    attribution: { updateMany: updateMany() },
    contactSuppression: { updateMany: updateMany() },
    crmActivity: { updateMany: updateMany() },
    contactIdentifier: { updateMany: updateMany() },
    socialProspect: { updateMany: updateMany() },
    socialOutreachThread: { updateMany: updateMany() },
    outboundDispatch: { updateMany: updateMany() },
    qualificationAnswer: {
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    pipeline: { findFirst: vi.fn(async () => null as unknown) },
    tag: { findFirst: vi.fn(async () => null as unknown) },
    contactTag: {
      findMany: vi.fn(async () => [] as unknown[]),
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => [] as unknown[]),
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  return m;
});

const sessionState = vi.hoisted(() => ({
  session: { userId: "user_1", organisationId: "org_1", role: "OWNER" as string },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/opt-out", () => ({ applyOptOut: vi.fn(async () => undefined), clearOptOut: vi.fn() }));
vi.mock("@/services/crm-activity", () => ({
  recordCrmActivity: vi.fn(async () => undefined),
  recordCrmActivities: vi.fn(async () => undefined),
}));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const guard = async () => sessionState.session;
  return {
    requireSession: vi.fn(guard),
    requirePermission: vi.fn(guard),
    requirePermissionForMutation: vi.fn(guard),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

import { writeAuditLog } from "@/services/audit";
import { recordCrmActivities, recordCrmActivity } from "@/services/crm-activity";
import { applyOptOut } from "@/services/opt-out";
import {
  metadataBlocksContact,
  mergedContactFields,
  pickLeadToKeep,
  type MergeContact,
} from "@/app/api/contacts/_lib/merge";

type Call = { where?: Record<string, unknown>; data?: unknown };
const calls = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map((c) => c[0] as Call);
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) as Promise<{ id: string }> });

function contactRow(overrides: Record<string, unknown>) {
  return {
    id: "c",
    fullName: null,
    email: null,
    phone: null,
    instagramUsername: null,
    location: null,
    timezone: null,
    leadSource: null,
    campaignSource: null,
    companyId: null,
    messagingChannelId: null,
    firstContactAt: new Date("2026-03-01T00:00:00Z"),
    lastContactAt: new Date("2026-03-01T00:00:00Z"),
    optedOut: false,
    optedOutAt: null,
    consentGiven: true,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.session = { userId: "user_1", organisationId: "org_1", role: "OWNER" };
  prismaMocks.$transaction.mockImplementation(async (cb: (tx: typeof prismaMocks) => unknown) => cb(prismaMocks));
  prismaMocks.contact.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/contacts/[id]/duplicates", () => {
  async function get(id = "c_1") {
    const { GET } = await import("@/app/api/contacts/[id]/duplicates/route");
    return GET(new Request(`http://localhost/api/contacts/${id}/duplicates`), params({ id }));
  }

  it("finds live contacts with the same email, phone digits or handle in this workspace", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({
      id: "c_1",
      email: " Ada@X.test",
      phone: "+44 7700 900123",
      instagramUsername: "@Ada",
    });
    prismaMocks.$queryRaw.mockResolvedValueOnce([
      { id: "c_2", fullName: "Ada L", email: "ada@x.test", phone: null, instagramUsername: null },
      { id: "c_3", fullName: "Ada IG", email: null, phone: "447700900123", instagramUsername: "ada" },
    ]);
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_3", fullName: "Ada IG", email: null, phone: "447700900123", instagramUsername: "ada", _count: { conversations: 2, leads: 1, deals: 0, notes: 0, bookings: 0 } },
      { id: "c_2", fullName: "Ada L", email: "ada@x.test", phone: null, instagramUsername: null, _count: { conversations: 0, leads: 0, deals: 0, notes: 1, bookings: 0 } },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const { duplicates } = await res.json();
    expect(duplicates.map((d: { id: string; matchedOn: string[] }) => [d.id, d.matchedOn])).toEqual([
      ["c_2", ["email"]],
      ["c_3", ["phone", "instagram"]],
    ]);
    expect(duplicates[1].counts.conversations).toBe(2);

    const sql = prismaMocks.$queryRaw.mock.calls[0]![0] as unknown as Prisma.Sql;
    expect(sql.values).toEqual(expect.arrayContaining(["org_1", "c_1", ["ada@x.test"], ["447700900123"], ["ada"]]));
    expect(sql.sql).toContain('"deletedAt" IS NULL');
    expect(calls(prismaMocks.contact.findMany)[0]!.where).toMatchObject({ organisationId: "org_1", deletedAt: null });
  });

  it("404 for another workspace's contact; no query when the contact has nothing to match on", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce(null);
    expect((await get("c_other_org")).status).toBe(404);
    expect(calls(prismaMocks.contact.findFirst)[0]!.where).toEqual({ id: "c_other_org", organisationId: "org_1", deletedAt: null });

    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", email: null, phone: "12", instagramUsername: null });
    const res = await get();
    expect((await res.json()).duplicates).toEqual([]);
    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("POST /api/contacts/[id]/merge", () => {
  async function merge(body: unknown, id = "c_keep") {
    const { POST } = await import("@/app/api/contacts/[id]/merge/route");
    return POST(
      new Request(`http://localhost/api/contacts/${id}/merge`, { method: "POST", body: JSON.stringify(body) }),
      params({ id }),
    );
  }

  const kept = contactRow({
    id: "c_keep",
    fullName: "Ada Lovelace",
    instagramUsername: "ada",
    metadata: { provenance: "manual" },
  });
  const dup = contactRow({
    id: "c_dup",
    fullName: "Ada L.",
    email: "ada@x.test",
    phone: "+1 555 0102000",
    leadSource: "instagram",
    companyId: "co_1",
    firstContactAt: new Date("2026-01-01T00:00:00Z"),
    lastContactAt: new Date("2026-05-01T00:00:00Z"),
    optedOut: true,
    optedOutAt: new Date("2026-04-01T00:00:00Z"),
    metadata: { DO_NOT_CONTACT: true, origin: "simulator" },
  });

  it("moves every contact-owned row, copies tags, fills empty fields and soft-deletes the duplicate", async () => {
    // Pre-check reads, then fresh reads under the row lock.
    prismaMocks.contact.findFirst
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup)
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup);
    prismaMocks.$queryRaw.mockResolvedValueOnce([{ id: "c_dup" }, { id: "c_keep" }]);
    prismaMocks.contactTag.findMany.mockResolvedValueOnce([{ tagId: "t1" }, { tagId: "t2" }]);
    prismaMocks.contactTag.createMany.mockResolvedValueOnce({ count: 1 });

    const res = await merge({ duplicateId: "c_dup" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, keptId: "c_keep", mergedId: "c_dup" });
    expect(body.moved).toMatchObject({ conversations: 2, leads: 2, deals: 2, identifiers: 2, tags: 1 });

    // Both contacts loaded inside the caller's workspace, live only, then locked FOR UPDATE.
    expect(calls(prismaMocks.contact.findFirst)[1]!.where).toEqual({ id: "c_dup", organisationId: "org_1", deletedAt: null });
    const lock = prismaMocks.$queryRaw.mock.calls[0]![0] as unknown as Prisma.Sql;
    expect(lock.sql).toContain("FOR UPDATE");
    expect(lock.values).toEqual(["c_keep", "c_dup", "org_1"]);

    for (const model of MOVED_MODELS) {
      expect(calls(prismaMocks[model].updateMany), model).toEqual([
        { where: { contactId: "c_dup", organisationId: "org_1" }, data: { contactId: "c_keep" } },
      ]);
    }

    // Tags: existing pairs are skipped, the duplicate's pairs removed.
    expect(calls(prismaMocks.contactTag.createMany)[0]).toEqual({
      data: [
        { contactId: "c_keep", tagId: "t1" },
        { contactId: "c_keep", tagId: "t2" },
      ],
      skipDuplicates: true,
    });
    expect(calls(prismaMocks.contactTag.deleteMany)[0]!.where).toEqual({ contactId: "c_dup" });

    // Duplicate claimed (soft-deleted) first, with mergedInto.
    const claim = calls(prismaMocks.contact.updateMany)[0]!;
    expect(claim.where).toEqual({ id: "c_dup", organisationId: "org_1", deletedAt: null });
    const claimData = claim.data as { deletedAt: Date; metadata: Record<string, unknown> };
    expect(claimData.deletedAt).toBeInstanceOf(Date);
    expect(claimData.metadata).toMatchObject({ mergedInto: "c_keep", mergedByUserId: "user_1", DO_NOT_CONTACT: true });

    // Kept contact: empty fields filled, nothing overwritten, opt-out and DNC carried over.
    const update = calls(prismaMocks.contact.update)[0]! as { where: unknown; data: Record<string, unknown> };
    expect(update.where).toEqual({ id: "c_keep" });
    expect(update.data).toMatchObject({
      email: "ada@x.test",
      phone: "+1 555 0102000",
      leadSource: "instagram",
      companyId: "co_1",
      firstContactAt: new Date("2026-01-01T00:00:00Z"),
      lastContactAt: new Date("2026-05-01T00:00:00Z"),
      optedOut: true,
      optedOutAt: new Date("2026-04-01T00:00:00Z"),
    });
    expect(update.data.fullName).toBeUndefined();
    expect(update.data.instagramUsername).toBeUndefined();
    const meta = update.data.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ provenance: "manual", DO_NOT_CONTACT: true });
    expect(meta.origin).toBeUndefined();
    expect(meta.mergedFrom).toEqual([expect.objectContaining({ contactId: "c_dup", mergedByUserId: "user_1" })]);

    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "merged", contactId: "c_keep", organisationId: "org_1" }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "contacts.merge" }));
  });

  it("leaves one live lead: re-points the others' rows, soft-deletes them and re-points pending approvals", async () => {
    prismaMocks.contact.findFirst
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup)
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup);
    prismaMocks.$queryRaw
      .mockResolvedValueOnce([{ id: "c_dup" }, { id: "c_keep" }]) // row lock
      .mockResolvedValueOnce([{ id: "ap_1" }]) // payload.contactId
      .mockResolvedValueOnce([]) // payload.context.contactId
      .mockResolvedValueOnce([{ id: "ap_1" }]) // payload.leadId (same request)
      .mockResolvedValueOnce([{ id: "ap_2" }]); // payload.context.leadId
    // The kept contact's live leads after the duplicate's moved over.
    prismaMocks.lead.findMany.mockResolvedValueOnce([
      { id: "lead_ai", conversationId: "conv_a", metadata: {}, updatedAt: new Date("2026-05-01"), stage: { position: 4, isLost: false } },
      { id: "lead_human", conversationId: null, metadata: { stageChangedBy: "HUMAN", note: "x" }, updatedAt: new Date("2026-03-01"), stage: { position: 1, isLost: false } },
      { id: "lead_lost", conversationId: "conv_l", metadata: { crmMemory: { a: 1 } }, updatedAt: new Date("2026-06-01"), stage: { position: 8, isLost: true } },
    ]);
    prismaMocks.qualificationAnswer.findMany.mockResolvedValue([{ fieldId: "f_budget" }]);

    const res = await merge({ duplicateId: "c_dup" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toMatchObject({ leadsMergedAway: 2, approvals: 2 });

    // Live leads of the kept contact only.
    expect(calls(prismaMocks.lead.findMany)[0]!.where).toEqual({ organisationId: "org_1", contactId: "c_keep", deletedAt: null });
    // The person-placed lead survives; rows of the other two move to it.
    for (const model of ["deal", "booking", "followUp", "crmActivity", "attribution"] as const) {
      expect(calls(prismaMocks[model].updateMany)[1], model).toEqual({
        where: { organisationId: "org_1", leadId: { in: ["lead_ai", "lead_lost"] } },
        data: { leadId: "lead_human" },
      });
    }
    // Qualification answers: only fields the kept lead hasn't answered.
    expect(calls(prismaMocks.qualificationAnswer.updateMany)[0]).toEqual({
      where: { leadId: "lead_ai", fieldId: { notIn: ["f_budget"] } },
      data: { leadId: "lead_human" },
    });
    const leadUpdates = calls(prismaMocks.lead.updateMany);
    // [0] moved the duplicate's leads; [1] the kept lead takes the most recent dropped conversation.
    expect(leadUpdates[1]).toEqual({ where: { id: "lead_human", organisationId: "org_1" }, data: { conversationId: "conv_l" } });
    // [2], [3] soft-delete the others, keeping their metadata, with mergedInto.
    expect(leadUpdates.slice(2).map((c) => c.where)).toEqual([
      { id: "lead_ai", organisationId: "org_1", deletedAt: null },
      { id: "lead_lost", organisationId: "org_1", deletedAt: null },
    ]);
    const dropped = leadUpdates[3]!.data as { deletedAt: Date; metadata: Record<string, unknown> };
    expect(dropped.deletedAt).toBeInstanceOf(Date);
    expect(dropped.metadata).toMatchObject({ crmMemory: { a: 1 }, mergedInto: "lead_human", mergedByUserId: "user_1" });

    // Pending approvals: raw jsonb_set, PENDING only, this workspace; the contact, then the leads.
    const sqls = prismaMocks.$queryRaw.mock.calls.slice(1).map((c) => c[0] as unknown as Prisma.Sql);
    expect(sqls).toHaveLength(4);
    for (const sql of sqls) {
      expect(sql.sql).toContain('UPDATE "ApprovalRequest"');
      expect(sql.sql).toContain("jsonb_set");
      expect(sql.sql).toContain(`"status" = 'PENDING'`);
    }
    expect(sqls[0]!.values).toEqual([["contactId"], "c_keep", "org_1", ["contactId"], ["c_dup"]]);
    expect(sqls[1]!.values).toEqual([["context", "contactId"], "c_keep", "org_1", ["context", "contactId"], ["c_dup"]]);
    expect(sqls[2]!.values).toEqual([["leadId"], "lead_human", "org_1", ["leadId"], ["lead_ai", "lead_lost"]]);
    prismaMocks.qualificationAnswer.findMany.mockResolvedValue([]);
  });

  it("does nothing extra when the kept contact ends up with a single lead", async () => {
    prismaMocks.contact.findFirst
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup)
      .mockResolvedValueOnce(kept)
      .mockResolvedValueOnce(dup);
    prismaMocks.$queryRaw.mockResolvedValueOnce([{ id: "c_dup" }, { id: "c_keep" }]);
    prismaMocks.lead.findMany.mockResolvedValueOnce([
      { id: "lead_1", conversationId: null, metadata: {}, updatedAt: new Date(), stage: { position: 0, isLost: false } },
    ]);
    const res = await merge({ duplicateId: "c_dup" });
    expect((await res.json()).moved).toMatchObject({ leadsMergedAway: 0 });
    expect(calls(prismaMocks.lead.updateMany)).toHaveLength(1);
    expect(calls(prismaMocks.deal.updateMany)).toHaveLength(1);
    // Lock + the two contactId approval passes; no lead passes without dropped leads.
    expect(prismaMocks.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("is refused for roles without pipeline:manage (sales agents)", async () => {
    sessionState.session = { ...sessionState.session, role: "SALES_AGENT" };
    const res = await merge({ duplicateId: "c_dup" });
    expect(res.status).toBe(403);
    expect(prismaMocks.contact.findFirst).not.toHaveBeenCalled();
  });

  it("404 when the duplicate belongs to another workspace", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce(kept).mockResolvedValueOnce(null);
    const res = await merge({ duplicateId: "c_other_org" });
    expect(res.status).toBe(404);
    expect(calls(prismaMocks.contact.findFirst)[1]!.where).toMatchObject({ id: "c_other_org", organisationId: "org_1" });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("400 for merging a contact into itself or a missing duplicateId", async () => {
    expect((await merge({ duplicateId: "c_keep" })).status).toBe(400);
    const missing = await merge({});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/Choose the duplicate/);
  });

  it("409 when one of the contacts was merged or deleted by someone else first — nothing moves", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce(kept).mockResolvedValueOnce(dup);
    prismaMocks.$queryRaw.mockResolvedValueOnce([{ id: "c_keep" }]);
    const res = await merge({ duplicateId: "c_dup" });
    expect(res.status).toBe(409);
    expect(prismaMocks.contact.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.conversation.updateMany).not.toHaveBeenCalled();
    expect(recordCrmActivity).not.toHaveBeenCalled();
  });
});

describe("POST /api/contacts/bulk", () => {
  async function bulk(body: unknown) {
    const { POST } = await import("@/app/api/contacts/bulk/route");
    return POST(new Request("http://localhost/api/contacts/bulk", { method: "POST", body: JSON.stringify(body) }));
  }

  it("only touches live contacts of this workspace and adds the tag where missing", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_1", optedOut: false },
      { id: "c_2", optedOut: false },
    ]);
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP" });
    prismaMocks.contactTag.findMany.mockResolvedValueOnce([{ contactId: "c_2" }]);

    const res = await bulk({ action: "add_tag", contactIds: ["c_1", "c_2", "c_other_org"], tagId: "t1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action: "add_tag",
      requested: 3,
      matched: 2,
      updated: 1,
      unchanged: 1,
      failed: 0,
      notFound: 1,
    });
    expect(calls(prismaMocks.contact.findMany)[0]!.where).toEqual({
      id: { in: ["c_1", "c_2", "c_other_org"] },
      organisationId: "org_1",
      deletedAt: null,
    });
    expect(calls(prismaMocks.tag.findFirst)[0]!.where).toEqual({ id: "t1", organisationId: "org_1" });
    expect(calls(prismaMocks.contactTag.createMany)[0]).toEqual({
      data: [{ contactId: "c_1", tagId: "t1" }],
      skipDuplicates: true,
    });
    const activities = (recordCrmActivities as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Array<{
      kind: string;
      contactId: string;
    }>;
    expect(activities.map((a) => [a.kind, a.contactId])).toEqual([["tagged", "c_1"]]);
  });

  it("rejects another workspace's tag", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([{ id: "c_1", optedOut: false }]);
    prismaMocks.tag.findFirst.mockResolvedValueOnce(null);
    const res = await bulk({ action: "remove_tag", contactIds: ["c_1"], tagId: "t_other_org" });
    expect(res.status).toBe(404);
    expect(prismaMocks.contactTag.deleteMany).not.toHaveBeenCalled();
  });

  it("remove_tag removes only existing pairs", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_1", optedOut: false },
      { id: "c_2", optedOut: false },
    ]);
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP" });
    prismaMocks.contactTag.findMany.mockResolvedValueOnce([{ contactId: "c_2" }]);
    const res = await bulk({ action: "remove_tag", contactIds: ["c_1", "c_2"], tagId: "t1" });
    expect(await res.json()).toMatchObject({ updated: 1, unchanged: 1 });
    expect(calls(prismaMocks.contactTag.deleteMany)[0]!.where).toEqual({ tagId: "t1", contactId: { in: ["c_2"] } });
  });

  it("add_to_pipeline creates leads only for contacts without one", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_1", optedOut: false },
      { id: "c_2", optedOut: false },
    ]);
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce({ id: "pl_1", stages: [{ id: "st_new", name: "New" }] });
    prismaMocks.lead.findMany.mockResolvedValueOnce([{ contactId: "c_2" }]);
    prismaMocks.conversation.findMany.mockResolvedValueOnce([{ id: "conv_1", contactId: "c_1" }]);
    prismaMocks.lead.createManyAndReturn.mockResolvedValueOnce([{ id: "lead_1", contactId: "c_1" }]);

    const res = await bulk({ action: "add_to_pipeline", contactIds: ["c_1", "c_2"] });
    expect(await res.json()).toMatchObject({ updated: 1, unchanged: 1, notFound: 0 });
    expect(calls(prismaMocks.lead.findMany)[0]!.where).toEqual({
      organisationId: "org_1",
      contactId: { in: ["c_1", "c_2"] },
      deletedAt: null,
    });
    const data = calls(prismaMocks.lead.createManyAndReturn)[0]!.data as Array<Record<string, unknown>>;
    expect(data).toEqual([
      expect.objectContaining({ organisationId: "org_1", contactId: "c_1", conversationId: "conv_1", stageId: "st_new" }),
    ]);
    const activities = (recordCrmActivities as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Array<{
      kind: string;
      leadId: string;
    }>;
    expect(activities).toEqual([expect.objectContaining({ kind: "added_to_pipeline", leadId: "lead_1" })]);
  });

  it("opt_out applies the opt-out to contacts not already opted out", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_1", optedOut: false },
      { id: "c_2", optedOut: true },
    ]);
    const res = await bulk({ action: "opt_out", contactIds: ["c_1", "c_2"] });
    expect(await res.json()).toMatchObject({ updated: 1, unchanged: 1 });
    expect(applyOptOut).toHaveBeenCalledTimes(1);
    expect(applyOptOut).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: "org_1", contactId: "c_1", userId: "user_1" }),
    );
  });

  it("opt_out records and counts the contacts that went through when some fail (200, not 500)", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([
      { id: "c_1", optedOut: false },
      { id: "c_2", optedOut: false },
      { id: "c_3", optedOut: false },
      { id: "c_4", optedOut: true },
    ]);
    vi.mocked(applyOptOut).mockImplementation(async (input: { contactId: string }) => {
      if (input.contactId === "c_2") throw new Error("deadlock detected");
    });
    const res = await bulk({ action: "opt_out", contactIds: ["c_1", "c_2", "c_3", "c_4"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: 4, updated: 2, failed: 1, unchanged: 1, notFound: 0 });
    expect(applyOptOut).toHaveBeenCalledTimes(3);
    const activities = (recordCrmActivities as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Array<{
      contactId: string;
    }>;
    expect(activities.map((a) => a.contactId)).toEqual(["c_1", "c_3"]);
    vi.mocked(applyOptOut).mockImplementation(async () => undefined);
  });

  it("opt_out is refused for sales agents (Owner / Administrator / Manager only)", async () => {
    sessionState.session = { ...sessionState.session, role: "SALES_AGENT" };
    const res = await bulk({ action: "opt_out", contactIds: ["c_1"] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Owner, Administrator or Manager/);
    expect(prismaMocks.contact.findMany).not.toHaveBeenCalled();
    expect(applyOptOut).not.toHaveBeenCalled();

    // Everyday bulk actions stay open to them.
    prismaMocks.contact.findMany.mockResolvedValueOnce([{ id: "c_1", optedOut: false }]);
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP" });
    expect((await bulk({ action: "add_tag", contactIds: ["c_1"], tagId: "t1" })).status).toBe(200);
  });

  it("delete is soft, scoped, audited — and refused for sales agents", async () => {
    sessionState.session = { ...sessionState.session, role: "SALES_AGENT" };
    expect((await bulk({ action: "delete", contactIds: ["c_1"] })).status).toBe(403);
    expect(prismaMocks.contact.findMany).not.toHaveBeenCalled();

    sessionState.session = { ...sessionState.session, role: "MANAGER" };
    prismaMocks.contact.findMany.mockResolvedValueOnce([{ id: "c_1", optedOut: false }]);
    const res = await bulk({ action: "delete", contactIds: ["c_1", "c_other_org"] });
    expect(await res.json()).toMatchObject({ updated: 1, notFound: 1 });
    const del = calls(prismaMocks.contact.updateMany)[0]!;
    expect(del.where).toEqual({ id: { in: ["c_1"] }, organisationId: "org_1", deletedAt: null });
    expect((del.data as { deletedAt: unknown }).deletedAt).toBeInstanceOf(Date);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "contacts.bulk_delete" }));
  });

  it("400s: unknown action, no ids, more than 500 ids, tag actions without a tag", async () => {
    const err = async (body: unknown) => {
      const res = await bulk(body);
      expect(res.status).toBe(400);
      return (await res.json()).error as string;
    };
    expect(await err({ action: "explode", contactIds: ["c_1"] })).toMatch(/Action must be one of/);
    expect(await err({ action: "opt_out", contactIds: [] })).toMatch(/at least one/);
    expect(await err({ action: "opt_out", contactIds: Array.from({ length: 501 }, (_, i) => `c_${i}`) })).toMatch(
      /at most 500/,
    );
    expect(await err({ action: "add_tag", contactIds: ["c_1"] })).toMatch(/Choose a tag/);
    expect(prismaMocks.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("merge rules", () => {
  const base = contactRow({ id: "c_keep" });
  const at = { at: new Date(), userId: "user_1" };

  it("a do-not-contact on the duplicate wins over a 'contactable' value on the kept contact", () => {
    const kept = { ...base, metadata: { doNotContact: false, contactability: "CONTACTABLE" } } as MergeContact;
    const dup = contactRow({ id: "c_dup", metadata: { do_not_contact: true, contactability: "DO_NOT_CONTACT" } }) as MergeContact;
    expect(metadataBlocksContact(kept.metadata)).toBe(false);
    const data = mergedContactFields(kept, dup, at);
    expect(data.metadata).toMatchObject({ do_not_contact: true, contactability: "DO_NOT_CONTACT", doNotContact: false });
    expect(metadataBlocksContact(data.metadata)).toBe(true);

    // Each blocking flag alone is enough, and a blocked kept contact stays blocked.
    for (const meta of [{ DO_NOT_CONTACT: true }, { doNotContact: true }, { contactability: "DO_NOT_CONTACT" }]) {
      const merged = mergedContactFields(
        { ...base, metadata: { DO_NOT_CONTACT: false, doNotContact: false, contactability: "OK" } } as MergeContact,
        contactRow({ id: "c_dup", metadata: meta }) as MergeContact,
        at,
      );
      expect(metadataBlocksContact(merged.metadata), JSON.stringify(meta)).toBe(true);
    }
    const stillBlocked = mergedContactFields(
      { ...base, metadata: { contactability: "DO_NOT_CONTACT" } } as MergeContact,
      contactRow({ id: "c_dup", metadata: { contactability: "CONTACTABLE", doNotContact: false } }) as MergeContact,
      at,
    );
    expect(metadataBlocksContact(stillBlocked.metadata)).toBe(true);
  });

  it("keeps the person-placed lead, else the most advanced (lost last), else the most recent", () => {
    const lead = (id: string, position: number | null, updated: string, meta: Record<string, unknown> = {}, isLost = false) => ({
      id,
      conversationId: null,
      metadata: meta,
      updatedAt: new Date(updated),
      stage: position === null ? null : { position, isLost },
    });
    expect(pickLeadToKeep([lead("a", 6, "2026-05-01"), lead("h", 1, "2026-01-01", { stageChangedBy: "HUMAN" })])!.id).toBe("h");
    expect(pickLeadToKeep([lead("a", 2, "2026-05-01"), lead("b", 5, "2026-01-01"), lead("x", null, "2026-06-01")])!.id).toBe("b");
    expect(pickLeadToKeep([lead("lost", 8, "2026-06-01", {}, true), lead("open", 0, "2026-01-01")])!.id).toBe("open");
    expect(pickLeadToKeep([lead("old", 3, "2026-01-01"), lead("new", 3, "2026-02-01")])!.id).toBe("new");
    expect(pickLeadToKeep([])).toBeNull();
  });
});
