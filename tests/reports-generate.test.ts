import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  conversation: { count: vi.fn(async () => 4), findMany: vi.fn(async () => [] as unknown[]) },
  lead: { count: vi.fn(async () => 2) },
  booking: { count: vi.fn(async () => 1) },
  followUp: { count: vi.fn(async () => 3) },
  objection: { groupBy: vi.fn(async () => [] as unknown[]) },
  detectedQuestion: { groupBy: vi.fn(async () => [] as unknown[]) },
  report: {
    findFirst: vi.fn(async () => null as unknown),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "rep_new", ...args.data })),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: args.where.id,
      ...args.data,
    })),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ userId: "user_1", organisationId: "org_1", role: "OWNER" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

type Where = { where: Record<string, unknown> };
const whereOf = (fn: { mock: { calls: unknown[][] } }) => (fn.mock.calls[0]![0] as Where).where;

async function generate() {
  const { POST } = await import("@/app/api/reports/route");
  return POST(
    new Request("http://localhost/api/reports", { method: "POST", body: JSON.stringify({ type: "daily" }) }),
  );
}

describe("POST /api/reports (Generate report)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes today's existing report with the fresh numbers instead of returning the stale one", async () => {
    prismaMocks.report.findFirst.mockResolvedValueOnce({
      id: "rep_today",
      payload: { newConversations: 0 },
    });
    const res = await generate();
    const json = await res.json();
    expect(prismaMocks.report.create).not.toHaveBeenCalled();
    expect(prismaMocks.report.update).toHaveBeenCalledTimes(1);
    const update = prismaMocks.report.update.mock.calls[0]![0];
    expect(update.where).toEqual({ id: "rep_today" });
    expect(update.data.payload).toMatchObject({ newConversations: 4, qualifiedLeads: 2, callsBooked: 1 });
    expect(json.payload.newConversations).toBe(4);
    expect(json.report.id).toBe("rep_today");
  });

  it("creates the first report of the day", async () => {
    await generate();
    expect(prismaMocks.report.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.report.update).not.toHaveBeenCalled();
  });

  it("ignores soft-deleted rows in the counts", async () => {
    await generate();
    expect(whereOf(prismaMocks.conversation.count)).toMatchObject({ organisationId: "org_1", deletedAt: null });
    expect(whereOf(prismaMocks.lead.count)).toMatchObject({ deletedAt: null });
    expect(whereOf(prismaMocks.booking.count)).toMatchObject({ contact: { deletedAt: null } });
    expect(whereOf(prismaMocks.followUp.count)).toMatchObject({ contact: { deletedAt: null } });
    expect(whereOf(prismaMocks.objection.groupBy)).toMatchObject({
      OR: [{ conversationId: null }, { conversation: { deletedAt: null } }],
    });
  });

  it("limits the attention list to live handoffs active in the report period", async () => {
    await generate();
    const where = whereOf(prismaMocks.conversation.findMany) as {
      deletedAt: null;
      needsHumanReview: boolean;
      lastMessageAt: { gte: Date; lte: Date };
    };
    expect(where.deletedAt).toBeNull();
    expect(where.needsHumanReview).toBe(true);
    const spanMs = where.lastMessageAt.lte.getTime() - where.lastMessageAt.gte.getTime();
    expect(spanMs).toBeGreaterThan(23 * 3_600_000);
    expect(spanMs).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
  });
});
