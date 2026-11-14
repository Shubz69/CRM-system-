import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  contact: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  conversation: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  deal: {
    findMany: vi.fn(async () => [] as unknown[]),
    count: vi.fn(async () => 0),
    groupBy: vi.fn(async () => [] as unknown[]),
  },
  pipeline: { findFirst: vi.fn(async () => null as unknown) },
  notification: {
    findMany: vi.fn(async () => [] as unknown[]),
    count: vi.fn(async () => 0),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
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

type Args = { where?: unknown; skip?: number; take?: number; select?: unknown; include?: unknown };
const firstArg = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0]![0] as Args;

describe("GET /api/contacts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts `total` with the same search filter as the list", async () => {
    prismaMocks.contact.count.mockResolvedValueOnce(3);
    const { GET } = await import("@/app/api/contacts/route");
    const res = await GET(new Request("http://localhost/api/contacts?q=ali"));
    const json = await res.json();
    expect(json.total).toBe(3);
    const listWhere = firstArg(prismaMocks.contact.findMany).where;
    const countWhere = firstArg(prismaMocks.contact.count).where;
    expect(countWhere).toEqual(listWhere);
    expect(JSON.stringify(countWhere)).toContain("ali");
    expect(countWhere).toMatchObject({ organisationId: "org_1", deletedAt: null });
  });

  it("supports limit/offset paging and reports the next offset", async () => {
    prismaMocks.contact.findMany.mockResolvedValueOnce([{ id: "c1" }, { id: "c2" }]);
    prismaMocks.contact.count.mockResolvedValueOnce(5);
    const { GET } = await import("@/app/api/contacts/route");
    const json = await (await GET(new Request("http://localhost/api/contacts?limit=2&offset=2"))).json();
    expect(firstArg(prismaMocks.contact.findMany)).toMatchObject({ skip: 2, take: 2 });
    expect(json.nextOffset).toBe(4);
  });

  it("caps the page size and keeps the old default of 100", async () => {
    const { GET } = await import("@/app/api/contacts/route");
    await GET(new Request("http://localhost/api/contacts?limit=99999"));
    await GET(new Request("http://localhost/api/contacts"));
    expect((prismaMocks.contact.findMany.mock.calls[0]![0] as Args).take).toBe(200);
    expect((prismaMocks.contact.findMany.mock.calls[1]![0] as Args).take).toBe(100);
  });

  it("countOnly returns the real total without loading rows", async () => {
    prismaMocks.contact.count.mockResolvedValueOnce(1234);
    const { GET } = await import("@/app/api/contacts/route");
    const json = await (await GET(new Request("http://localhost/api/contacts?countOnly=1"))).json();
    expect(json.total).toBe(1234);
    expect(prismaMocks.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/conversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("summary=1 returns real counts (not the length of a capped list)", async () => {
    prismaMocks.conversation.count
      .mockResolvedValueOnce(450)
      .mockResolvedValueOnce(120)
      .mockResolvedValueOnce(210);
    const { GET } = await import("@/app/api/conversations/route");
    const json = await (await GET(new Request("http://localhost/api/conversations?summary=1"))).json();
    expect(json).toEqual({ total: 450, needingHuman: 120, needsReply: 210 });
    expect(prismaMocks.conversation.findMany).not.toHaveBeenCalled();
    for (const call of prismaMocks.conversation.count.mock.calls as unknown as Array<[Args]>) {
      expect(call[0].where).toMatchObject({ organisationId: "org_1", deletedAt: null });
    }
  });

  it("list honours ?limit (for Load more) and returns the total", async () => {
    prismaMocks.conversation.count.mockResolvedValueOnce(321);
    const { GET } = await import("@/app/api/conversations/route");
    const json = await (await GET(new Request("http://localhost/api/conversations?limit=200"))).json();
    expect(firstArg(prismaMocks.conversation.findMany).take).toBe(200);
    expect(json.total).toBe(321);
  });
});

describe("GET /api/deals?summary=1", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts open deals and sums value per currency (never mixing currencies)", async () => {
    prismaMocks.deal.count.mockResolvedValueOnce(140);
    prismaMocks.deal.groupBy.mockResolvedValueOnce([
      { currency: "USD", _sum: { amountCents: 50_000 } },
      { currency: "GBP", _sum: { amountCents: 120_000 } },
      { currency: "EUR", _sum: { amountCents: null } },
    ]);
    const { GET } = await import("@/app/api/deals/route");
    const json = await (await GET(new Request("http://localhost/api/deals?summary=1"))).json();
    expect(json.openDeals).toBe(140);
    expect(json.openValueByCurrency).toEqual([
      { currency: "GBP", amountCents: 120_000 },
      { currency: "USD", amountCents: 50_000 },
    ]);
    expect(firstArg(prismaMocks.deal.count).where).toEqual({
      organisationId: "org_1",
      deletedAt: null,
      status: "OPEN",
    });
  });
});

describe("pipeline endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/pipeline/stages returns the default pipeline's stages only", async () => {
    prismaMocks.pipeline.findFirst.mockResolvedValueOnce({
      id: "pipe_1",
      stages: [{ id: "s1", name: "New", slug: "new", position: 0 }],
    });
    const { GET } = await import("@/app/api/pipeline/stages/route");
    const json = await (await GET()).json();
    expect(json).toEqual({ pipelineId: "pipe_1", stages: [{ id: "s1", name: "New", slug: "new", position: 0 }] });
    const args = firstArg(prismaMocks.pipeline.findFirst);
    expect(args.where).toEqual({ organisationId: "org_1", isDefault: true });
    expect(JSON.stringify(args)).not.toContain("leads");
  });

  it("GET /api/pipeline/stages copes with no pipeline", async () => {
    const { GET } = await import("@/app/api/pipeline/stages/route");
    const json = await (await GET()).json();
    expect(json).toEqual({ pipelineId: null, stages: [] });
  });

  it("GET /api/pipeline only selects the contact fields the board renders", async () => {
    const { GET } = await import("@/app/api/pipeline/route");
    await GET();
    const args = firstArg(prismaMocks.pipeline.findFirst) as {
      include: { stages: { include: { leads: { select: { contact: { select: Record<string, boolean> } } } } } };
    };
    expect(args.include.stages.include.leads.select.contact.select).toEqual({
      fullName: true,
      instagramUsername: true,
    });
  });
});

describe("notifications API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unreadCount is a real count, not just among the 50 newest", async () => {
    prismaMocks.notification.findMany.mockResolvedValueOnce([{ id: "n1", readAt: new Date() }]);
    prismaMocks.notification.count.mockResolvedValueOnce(73);
    const { GET } = await import("@/app/api/notifications/route");
    const json = await (await GET()).json();
    expect(json.unreadCount).toBe(73);
    expect(firstArg(prismaMocks.notification.count).where).toMatchObject({ readAt: null });
  });

  it("marking one read only touches that notification and keeps earlier read times", async () => {
    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(
      new Request("http://localhost/api/notifications", {
        method: "PATCH",
        body: JSON.stringify({ id: "n1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(firstArg(prismaMocks.notification.updateMany).where).toMatchObject({
      organisationId: "org_1",
      id: "n1",
      readAt: null,
    });
  });
});
