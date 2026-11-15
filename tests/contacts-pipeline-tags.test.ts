import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contacts → pipeline ("Add to pipeline") and tags (workspace tags + tags on a contact).
 * Prisma is mocked; every test checks the query is scoped to the caller's organisation.
 */

const prismaMocks = vi.hoisted(() => {
  const fn = <T = unknown>(impl?: (...args: never[]) => T) => vi.fn(impl ?? (async () => null as unknown as T));
  const m = {
    contact: { findFirst: fn(), findMany: fn(async () => []), count: fn(async () => 0) },
    lead: { findFirst: fn(), findMany: fn(async () => []), createManyAndReturn: fn(async () => []) },
    pipeline: { findFirst: fn() },
    conversation: { findMany: fn(async () => []) },
    tag: {
      findFirst: fn(),
      findMany: fn(async () => []),
      create: fn(),
      update: fn(),
      deleteMany: fn(async () => ({ count: 1 })),
    },
    contactTag: {
      findMany: fn(async () => []),
      createMany: fn(async () => ({ count: 1 })),
      deleteMany: fn(async () => ({ count: 1 })),
    },
    $executeRaw: fn(async () => 1),
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (cb: (tx: typeof m) => unknown) => cb(m));
  return m;
});

const sessionState = vi.hoisted(() => ({
  session: { userId: "user_1", organisationId: "org_1", role: "OWNER" as string },
  deny: null as string | null,
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/opt-out", () => ({ applyOptOut: vi.fn(), clearOptOut: vi.fn() }));
vi.mock("@/services/crm-activity", () => ({
  recordCrmActivity: vi.fn(async () => undefined),
  recordCrmActivities: vi.fn(async () => undefined),
}));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const guard = async () => {
    if (sessionState.deny) throw new Error(`Forbidden: missing permission ${sessionState.deny}`);
    return sessionState.session;
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

import { recordCrmActivity } from "@/services/crm-activity";

type Call = { where?: Record<string, unknown>; data?: unknown; select?: unknown };
const calls = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map((c) => c[0] as Call);
const json = (body: unknown) => JSON.stringify(body);
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const PIPELINE = {
  id: "pl_1",
  stages: [
    { id: "st_new", name: "New" },
    { id: "st_qual", name: "Qualified" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.session = { userId: "user_1", organisationId: "org_1", role: "OWNER" };
  sessionState.deny = null;
  prismaMocks.$transaction.mockImplementation(async (cb: (tx: typeof prismaMocks) => unknown) => cb(prismaMocks));
  prismaMocks.lead.createManyAndReturn.mockImplementation((async (args: { data: Array<{ contactId: string }> }) =>
    args.data.map((d, i) => ({ id: `lead_${i + 1}`, contactId: d.contactId }))) as never);
});

describe("POST /api/contacts/[id]/lead", () => {
  async function post(body?: unknown, id = "c_1") {
    const { POST } = await import("@/app/api/contacts/[id]/lead/route");
    return POST(
      new Request(`http://localhost/api/contacts/${id}/lead`, {
        method: "POST",
        body: body === undefined ? undefined : typeof body === "string" ? body : json(body),
      }),
      params({ id }),
    );
  }

  it("creates a lead in the default pipeline's first stage, linked to the latest conversation", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce(PIPELINE);
    prismaMocks.conversation.findMany.mockResolvedValueOnce([
      { id: "conv_new", contactId: "c_1" },
      { id: "conv_old", contactId: "c_1" },
    ]);

    const res = await post();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lead).toMatchObject({ id: "lead_1", stage: { id: "st_new", name: "New" }, pipelineId: "pl_1" });

    expect(calls(prismaMocks.contact.findFirst)[0]!.where).toEqual({ id: "c_1", organisationId: "org_1", deletedAt: null });
    expect(calls(prismaMocks.pipeline.findFirst)[0]!.where).toEqual({ organisationId: "org_1", isDefault: true });
    expect(calls(prismaMocks.conversation.findMany)[0]!.where).toEqual({
      organisationId: "org_1",
      contactId: { in: ["c_1"] },
      deletedAt: null,
    });
    const created = (calls(prismaMocks.lead.createManyAndReturn)[0]!.data as Array<Record<string, unknown>>)[0]!;
    expect(created).toMatchObject({
      organisationId: "org_1",
      contactId: "c_1",
      conversationId: "conv_new",
      pipelineId: "pl_1",
      stageId: "st_new",
    });
    // Default stage: the AI may still move it later.
    expect((created.metadata as Record<string, unknown>).stageChangedBy).toBeUndefined();
    expect(prismaMocks.$executeRaw).toHaveBeenCalledTimes(1);
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "added_to_pipeline", contactId: "c_1", leadId: "lead_1", organisationId: "org_1" }),
    );
  });

  it("defaults to the \"new\" stage like inbound leads, even when a custom stage sits above it", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce({
      id: "pl_1",
      stages: [
        { id: "st_triage", name: "Triage", slug: "triage" },
        { id: "st_new", name: "New", slug: "new" },
      ],
    });
    const res = await post({});
    expect(res.status).toBe(201);
    expect((await res.json()).lead.stage).toEqual({ id: "st_new", name: "New" });
    const created = (calls(prismaMocks.lead.createManyAndReturn)[0]!.data as Array<Record<string, unknown>>)[0]!;
    expect(created.stageId).toBe("st_new");

    // No "new" stage: the first stage by position.
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce({
      id: "pl_1",
      stages: [
        { id: "st_triage", name: "Triage", slug: "triage" },
        { id: "st_qual", name: "Qualified", slug: "qualified" },
      ],
    });
    expect((await (await post({})).json()).lead.stage).toEqual({ id: "st_triage", name: "Triage" });
  });

  it("uses no conversation when the contact has none, and honours a chosen stage", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce(PIPELINE);
    const res = await post({ stageId: "st_qual" });
    expect(res.status).toBe(201);
    const created = (calls(prismaMocks.lead.createManyAndReturn)[0]!.data as Array<Record<string, unknown>>)[0]!;
    expect(created.conversationId).toBeNull();
    expect(created.stageId).toBe("st_qual");
    expect((created.metadata as Record<string, unknown>).stageChangedBy).toBe("HUMAN");
  });

  it("is idempotent: 409 with the existing lead when the contact already has one", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.lead.findFirst.mockResolvedValueOnce({ id: "lead_9", stage: { id: "st_new", name: "New" } });
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).lead.id).toBe("lead_9");
    expect(calls(prismaMocks.lead.findFirst)[0]!.where).toEqual({ contactId: "c_1", organisationId: "org_1", deletedAt: null });
    expect(prismaMocks.lead.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("409 when a concurrent request created the lead under the lock", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce(PIPELINE);
    prismaMocks.lead.findMany.mockResolvedValueOnce([{ contactId: "c_1" }]);
    const res = await post({});
    expect(res.status).toBe(409);
    expect(prismaMocks.lead.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("404 for another workspace's contact", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce(null);
    const res = await post({}, "c_other_org");
    expect(res.status).toBe(404);
    expect(calls(prismaMocks.contact.findFirst)[0]!.where).toMatchObject({ id: "c_other_org", organisationId: "org_1" });
    expect(prismaMocks.lead.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("404 for a stage that is not in this workspace's pipeline", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce(PIPELINE);
    const res = await post({ stageId: "st_other_org" });
    expect(res.status).toBe(404);
    expect(prismaMocks.lead.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("409 with a readable message when the workspace has no pipeline", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1", fullName: "Ada" });
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce(null);
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no pipeline/i);
  });

  it("400 for malformed JSON and 403 without leads:write", async () => {
    expect((await post("{not json")).status).toBe(400);
    sessionState.deny = "leads:write";
    expect((await post({})).status).toBe(403);
  });
});

describe("/api/tags", () => {
  it("GET lists this workspace's tags with live-contact counts", async () => {
    prismaMocks.tag.findMany.mockResolvedValueOnce([
      { id: "t1", name: "VIP", color: "#0c6b64", createdAt: new Date(), _count: { contacts: 3 } },
    ]);
    const { GET } = await import("@/app/api/tags/route");
    const body = await (await GET()).json();
    expect(body.tags[0]).toMatchObject({ id: "t1", name: "VIP", contactCount: 3 });
    const args = calls(prismaMocks.tag.findMany)[0] as Call & { select: { _count: unknown } };
    expect(args.where).toEqual({ organisationId: "org_1" });
    expect(args.select._count).toEqual({ select: { contacts: { where: { contact: { deletedAt: null } } } } });
  });

  async function create(body: unknown) {
    const { POST } = await import("@/app/api/tags/route");
    return POST(new Request("http://localhost/api/tags", { method: "POST", body: json(body) }));
  }

  it("POST trims the name, applies the colour and checks uniqueness case-insensitively", async () => {
    prismaMocks.tag.create.mockImplementationOnce((async (args: { data: Record<string, unknown> }) => ({
      id: "t2",
      createdAt: new Date(),
      ...args.data,
    })) as never);
    const res = await create({ name: "  Wholesale   buyers ", color: "#2563EB" });
    expect(res.status).toBe(201);
    expect(calls(prismaMocks.tag.findFirst)[0]!.where).toEqual({
      organisationId: "org_1",
      name: { equals: "Wholesale buyers", mode: "insensitive" },
    });
    expect(calls(prismaMocks.tag.create)[0]!.data).toEqual({
      organisationId: "org_1",
      name: "Wholesale buyers",
      color: "#2563eb",
    });
  });

  it("POST rejects duplicates, long names, empty names and bad colours with readable 4xx", async () => {
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" });
    const dup = await create({ name: "vip" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toContain('"VIP" already exists');

    const long = await create({ name: "x".repeat(41) });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toMatch(/at most 40/);
    expect((await create({ name: "   " })).status).toBe(400);
    expect((await create({ name: "Ok", color: "teal" })).status).toBe(400);
    expect(prismaMocks.tag.create).not.toHaveBeenCalled();
  });

  it("PATCH renames / recolours only this workspace's tag", async () => {
    const { PATCH } = await import("@/app/api/tags/[id]/route");
    const patch = (id: string, body: unknown) =>
      PATCH(new Request(`http://localhost/api/tags/${id}`, { method: "PATCH", body: json(body) }), params({ id }));

    prismaMocks.tag.findFirst.mockResolvedValueOnce(null);
    expect((await patch("t_other_org", { name: "Mine" })).status).toBe(404);
    expect(calls(prismaMocks.tag.findFirst)[0]!.where).toEqual({ id: "t_other_org", organisationId: "org_1" });

    prismaMocks.tag.findFirst
      .mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" })
      .mockResolvedValueOnce({ id: "t2", name: "Leads", color: "#000000" });
    expect((await patch("t1", { name: "leads" })).status).toBe(409);

    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" });
    prismaMocks.tag.update.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#16a34a" });
    const ok = await patch("t1", { color: "#16a34a" });
    expect(ok.status).toBe(200);
    expect(calls(prismaMocks.tag.update)[0]).toMatchObject({ where: { id: "t1" }, data: { color: "#16a34a" } });

    expect((await patch("t1", {})).status).toBe(400);
  });

  it("DELETE refuses another workspace's tag and scopes the delete", async () => {
    const { DELETE } = await import("@/app/api/tags/[id]/route");
    const del = (id: string) => DELETE(new Request(`http://localhost/api/tags/${id}`, { method: "DELETE" }), params({ id }));
    prismaMocks.tag.findFirst.mockResolvedValueOnce(null);
    expect((await del("t_other_org")).status).toBe(404);
    expect(prismaMocks.tag.deleteMany).not.toHaveBeenCalled();

    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" });
    expect((await del("t1")).status).toBe(200);
    expect(calls(prismaMocks.tag.deleteMany)[0]!.where).toEqual({ id: "t1", organisationId: "org_1" });
  });

  it("renaming, recolouring and deleting tags is for Owner / Administrator / Manager; sales agents can still create them", async () => {
    sessionState.session = { ...sessionState.session, role: "SALES_AGENT" };
    const { PATCH, DELETE } = await import("@/app/api/tags/[id]/route");
    const patch = await PATCH(
      new Request("http://localhost/api/tags/t1", { method: "PATCH", body: json({ name: "Renamed" }) }),
      params({ id: "t1" }),
    );
    expect(patch.status).toBe(403);
    expect((await patch.json()).error).toMatch(/Owner, Administrator or Manager/);
    const del = await DELETE(new Request("http://localhost/api/tags/t1", { method: "DELETE" }), params({ id: "t1" }));
    expect(del.status).toBe(403);
    expect(prismaMocks.tag.findFirst).not.toHaveBeenCalled();
    expect(prismaMocks.tag.update).not.toHaveBeenCalled();
    expect(prismaMocks.tag.deleteMany).not.toHaveBeenCalled();

    const { POST } = await import("@/app/api/tags/route");
    prismaMocks.tag.create.mockResolvedValueOnce({ id: "t9", name: "Mine", color: "#64748b", createdAt: new Date() });
    const created = await POST(new Request("http://localhost/api/tags", { method: "POST", body: json({ name: "Mine" }) }));
    expect(created.status).toBe(201);

    sessionState.session = { ...sessionState.session, role: "MANAGER" };
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" });
    expect((await DELETE(new Request("http://localhost/api/tags/t1", { method: "DELETE" }), params({ id: "t1" }))).status).toBe(200);
  });
});

describe("tags on a contact", () => {
  async function add(body: unknown, id = "c_1") {
    const { POST } = await import("@/app/api/contacts/[id]/tags/route");
    return POST(new Request(`http://localhost/api/contacts/${id}/tags`, { method: "POST", body: json(body) }), params({ id }));
  }

  it("adds an existing tag and records a 'tagged' activity", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1" });
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP", color: "#000000" });
    const res = await add({ tagId: "t1" });
    expect(res.status).toBe(201);
    expect(calls(prismaMocks.tag.findFirst)[0]!.where).toEqual({ id: "t1", organisationId: "org_1" });
    expect(calls(prismaMocks.contactTag.createMany)[0]).toEqual({
      data: [{ contactId: "c_1", tagId: "t1" }],
      skipDuplicates: true,
    });
    expect(recordCrmActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "tagged", contactId: "c_1" }));
  });

  it("rejects another workspace's tag or contact", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1" });
    prismaMocks.tag.findFirst.mockResolvedValueOnce(null);
    expect((await add({ tagId: "t_other_org" })).status).toBe(404);

    prismaMocks.contact.findFirst.mockResolvedValueOnce(null);
    expect((await add({ tagId: "t1" }, "c_other_org")).status).toBe(404);
    expect(prismaMocks.contactTag.createMany).not.toHaveBeenCalled();
  });

  it("creates a tag by name when none matches, and records nothing when already tagged", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1" });
    prismaMocks.tag.findFirst.mockResolvedValueOnce(null);
    prismaMocks.tag.create.mockResolvedValueOnce({ id: "t9", name: "Newbie", color: "#64748b" });
    prismaMocks.contactTag.createMany.mockResolvedValueOnce({ count: 0 });
    const res = await add({ name: " Newbie " });
    expect(res.status).toBe(200);
    expect((await res.json()).tagCreated).toBe(true);
    expect(calls(prismaMocks.tag.create)[0]!.data).toMatchObject({ organisationId: "org_1", name: "Newbie" });
    expect(recordCrmActivity).not.toHaveBeenCalled();
  });

  it("DELETE removes the tag from the contact and records it", async () => {
    const { DELETE } = await import("@/app/api/contacts/[id]/tags/[tagId]/route");
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1" });
    prismaMocks.tag.findFirst.mockResolvedValueOnce({ id: "t1", name: "VIP" });
    const res = await DELETE(
      new Request("http://localhost/api/contacts/c_1/tags/t1", { method: "DELETE" }),
      params({ id: "c_1", tagId: "t1" }),
    );
    expect(res.status).toBe(200);
    expect(calls(prismaMocks.contactTag.deleteMany)[0]!.where).toEqual({ contactId: "c_1", tagId: "t1" });
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tagged", title: 'Removed tag "VIP"' }),
    );
  });

  it("PATCH tagIds records which tags were added and removed", async () => {
    const { PATCH } = await import("@/app/api/contacts/[id]/route");
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "c_1" });
    prismaMocks.tag.findMany.mockResolvedValueOnce([{ id: "t2", name: "Hot" }]);
    prismaMocks.contactTag.findMany.mockResolvedValueOnce([{ tagId: "t1", tag: { name: "VIP" } }]);
    const res = await PATCH(
      new Request("http://localhost/api/contacts/c_1", { method: "PATCH", body: json({ tagIds: ["t2"] }) }),
      params({ id: "c_1" }),
    );
    expect(res.status).toBe(200);
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tagged",
        metadata: { added: [{ id: "t2", name: "Hot" }], removed: [{ id: "t1", name: "VIP" }] },
      }),
    );
  });

  it("GET /api/contacts?tagId= filters by a tag of this workspace", async () => {
    const { GET } = await import("@/app/api/contacts/route");
    await GET(new Request("http://localhost/api/contacts?tagId=t1"));
    const where = calls(prismaMocks.contact.findMany)[0]!.where!;
    expect(where).toMatchObject({
      organisationId: "org_1",
      deletedAt: null,
      tags: { some: { tagId: "t1", tag: { organisationId: "org_1" } } },
    });
    expect(calls(prismaMocks.contact.count)[0]!.where).toEqual(where);
  });
});
