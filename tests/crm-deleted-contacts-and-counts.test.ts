import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  conversation: {
    findMany: vi.fn(async () => [] as unknown[]),
    count: vi.fn(async () => 0),
    fields: { lastOutboundAt: { name: "lastOutboundAt", modelName: "Conversation" } },
  },
  lead: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  booking: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  followUp: { count: vi.fn(async () => 0) },
  objection: { groupBy: vi.fn(async () => [] as unknown[]) },
  detectedQuestion: { groupBy: vi.fn(async () => [] as unknown[]) },
  report: {
    findFirst: vi.fn(async () => null as unknown),
    create: vi.fn(async () => ({ id: "rep_1" })),
    update: vi.fn(async () => ({ id: "rep_1" })),
  },
  knowledgeRecommendation: { findMany: vi.fn(async () => [] as unknown[]) },
  failedJob: { findMany: vi.fn(async () => [] as unknown[]) },
  integration: { findMany: vi.fn(async () => [] as unknown[]) },
  pipeline: { findFirst: vi.fn(async () => null as unknown) },
  company: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  contact: {
    findFirst: vi.fn(async () => null as unknown),
    update: vi.fn(async () => ({ id: "contact_1" })),
  },
  note: { create: vi.fn() },
  tag: { findMany: vi.fn(async () => [] as unknown[]) },
  contactTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  organisationMember: { findMany: vi.fn(async () => [] as unknown[]) },
  notification: {
    createManyAndReturn: vi.fn(async (args: { data: unknown[] }) =>
      args.data.map((_, i) => ({ id: `n${i + 1}` })),
    ),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/opt-out", () => ({ applyOptOut: vi.fn(), clearOptOut: vi.fn() }));
vi.mock("@/services/crm-v2", () => ({ upsertCompany: vi.fn() }));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = { userId: "user_1", organisationId: "org_1", role: "OWNER" };
  return {
    requireSession: vi.fn(async () => session),
    requirePermission: vi.fn(async () => session),
    requirePermissionForMutation: vi.fn(async () => session),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

type Call = { where?: Record<string, unknown>; include?: unknown; data?: unknown };
const calls = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => c[0] as Call);
const LIVE_CONTACT = { contact: { deletedAt: null } };

describe("conversations list + summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leave out a deleted contact's threads", async () => {
    const { GET } = await import("@/app/api/conversations/route");
    await GET(new Request("http://localhost/api/conversations"));
    await GET(new Request("http://localhost/api/conversations?summary=1"));
    for (const c of [...calls(prismaMocks.conversation.findMany), ...calls(prismaMocks.conversation.count)]) {
      expect(c.where).toMatchObject({ organisationId: "org_1", deletedAt: null, ...LIVE_CONTACT });
    }
  });

  it("'needs reply' uses the inbox rule: the customer spoke last", async () => {
    const { GET } = await import("@/app/api/conversations/route");
    await GET(new Request("http://localhost/api/conversations?summary=1"));
    const needsReply = calls(prismaMocks.conversation.count)[2]!;
    expect(needsReply.where!.OR).toEqual([
      { lastInboundAt: { gt: prismaMocks.conversation.fields.lastOutboundAt } },
      { lastOutboundAt: null, lastInboundAt: { not: null } },
    ]);
    // Unread alone no longer counts as "needs reply".
    expect(JSON.stringify(needsReply.where)).not.toContain("unreadCount");
  });
});

describe("pipeline, attention and reports skip deleted contacts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/pipeline only lists leads of live contacts", async () => {
    const { GET } = await import("@/app/api/pipeline/route");
    await GET();
    const args = calls(prismaMocks.pipeline.findFirst)[0] as {
      include: { stages: { include: { leads: { where: unknown } } } };
    };
    expect(args.include.stages.include.leads.where).toEqual({ deletedAt: null, ...LIVE_CONTACT });
  });

  it("GET /api/attention filters handoffs, low confidence, hot leads and bookings", async () => {
    const { GET } = await import("@/app/api/attention/route");
    await GET();
    const filtered = [
      ...calls(prismaMocks.conversation.findMany),
      ...calls(prismaMocks.lead.findMany),
      ...calls(prismaMocks.booking.findMany),
    ];
    expect(filtered).toHaveLength(4);
    for (const c of filtered) expect(c.where).toMatchObject(LIVE_CONTACT);
  });

  it("POST /api/reports counts only live contacts' conversations, leads and signals", async () => {
    const { POST } = await import("@/app/api/reports/route");
    const res = await POST(new Request("http://localhost/api/reports", { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    for (const fn of [prismaMocks.conversation.count, prismaMocks.lead.count, prismaMocks.booking.count]) {
      expect(calls(fn)[0]!.where).toMatchObject(LIVE_CONTACT);
    }
    for (const fn of [prismaMocks.objection.groupBy, prismaMocks.detectedQuestion.groupBy]) {
      expect(calls(fn)[0]!.where!.OR).toEqual([
        { conversationId: null },
        { conversation: { deletedAt: null, ...LIVE_CONTACT } },
      ]);
    }
  });
});

describe("GET /api/companies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the real total (same filter as the capped list)", async () => {
    prismaMocks.company.count.mockResolvedValueOnce(250);
    const { GET } = await import("@/app/api/companies/route");
    const json = await (await GET(new Request("http://localhost/api/companies"))).json();
    expect(json.total).toBe(250);
    expect(calls(prismaMocks.company.count)[0]!.where).toEqual(calls(prismaMocks.company.findMany)[0]!.where);
    // Related counts leave out soft-deleted contacts and deals.
    expect(calls(prismaMocks.company.findMany)[0]!.include).toEqual({
      _count: {
        select: { contacts: { where: { deletedAt: null } }, deals: { where: { deletedAt: null } } },
      },
    });
  });

  it("countOnly skips loading rows", async () => {
    prismaMocks.company.count.mockResolvedValueOnce(1234);
    const { GET } = await import("@/app/api/companies/route");
    const json = await (await GET(new Request("http://localhost/api/companies?countOnly=1"))).json();
    expect(json.total).toBe(1234);
    expect(prismaMocks.company.findMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/contacts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "contact_1" });
  });

  async function patch(body: Record<string, unknown>) {
    const { PATCH } = await import("@/app/api/contacts/[id]/route");
    return PATCH(
      new Request("http://localhost/api/contacts/contact_1", { method: "PATCH", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: "contact_1" }) },
    );
  }

  it("edits name, email and phone", async () => {
    const res = await patch({ fullName: "  Ada Lovelace ", email: "ada@x.test", phone: null });
    expect(res.status).toBe(200);
    expect(prismaMocks.contact.update).toHaveBeenCalledWith({
      where: { id: "contact_1" },
      data: { fullName: "Ada Lovelace", email: "ada@x.test", phone: null, deletedAt: undefined },
    });
  });

  it("refuses an email another live contact already uses", async () => {
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "contact_2" });
    const res = await patch({ email: "taken@x.test" });
    expect(res.status).toBe(409);
    expect(calls(prismaMocks.contact.findFirst)[1]!.where).toEqual({
      organisationId: "org_1",
      deletedAt: null,
      email: "taken@x.test",
      id: { not: "contact_1" },
    });
    expect(prismaMocks.contact.update).not.toHaveBeenCalled();
  });

  it("rejects an empty name", async () => {
    const res = await patch({ fullName: "   " });
    expect(res.status).toBe(400);
    expect(prismaMocks.contact.update).not.toHaveBeenCalled();
  });

  it("delete soft-deletes the contact", async () => {
    const res = await patch({ deleted: true });
    expect(res.status).toBe(200);
    const data = calls(prismaMocks.contact.update)[0]!.data as { deletedAt: unknown };
    expect(data.deletedAt).toBeInstanceOf(Date);
  });
});

describe("createNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("org-wide: one row per active member, so read state is per person", async () => {
    prismaMocks.organisationMember.findMany.mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);
    const { createNotification } = await import("@/services/notifications");
    const ids = await createNotification({
      organisationId: "org_1",
      type: "TASK",
      title: "Task",
      body: "Follow up",
      metadata: { leadId: "lead_1" },
    });
    expect(ids).toEqual(["n1", "n2"]);
    expect(calls(prismaMocks.organisationMember.findMany)[0]!.where).toEqual({
      organisationId: "org_1",
      user: { deletedAt: null, isActive: true, isSuspended: false },
    });
    const rows = (calls(prismaMocks.notification.createManyAndReturn)[0]!.data as Array<{ userId: string | null }>);
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
  });

  it("for one person: a single row and no member lookup", async () => {
    const { createNotification } = await import("@/services/notifications");
    await createNotification({ organisationId: "org_1", userId: "u9", type: "TASK", title: "T", body: "B" });
    expect(prismaMocks.organisationMember.findMany).not.toHaveBeenCalled();
    const rows = calls(prismaMocks.notification.createManyAndReturn)[0]!.data as Array<{ userId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe("u9");
  });

  it("never writes a shared (userId-less) row", async () => {
    const { createNotification } = await import("@/services/notifications");
    const ids = await createNotification({ organisationId: "org_1", type: "TASK", title: "T", body: "B" });
    expect(ids).toEqual([]);
    expect(prismaMocks.notification.createManyAndReturn).not.toHaveBeenCalled();
  });
});
