import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const prismaMocks = vi.hoisted(() => {
  const mocks = {
    company: { findFirst: vi.fn(async () => null as unknown) },
    contact: { findFirst: vi.fn(async () => null as unknown) },
    lead: { findFirst: vi.fn(async () => null as unknown) },
    deal: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "deal_1", ...args.data })),
      findMany: vi.fn(async () => [] as unknown[]),
    },
    $transaction: vi.fn(),
  };
  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks));
  return mocks;
});

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: vi.fn(async () => ({ id: "evt" })),
}));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = { userId: "user_1", organisationId: "org_1", role: "OWNER" };
  return {
    requirePermission: vi.fn(async () => session),
    requirePermissionForMutation: vi.fn(async () => session),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

function post(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/deals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("deals never link to another workspace's records", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["companyId", "Company"],
    ["contactId", "Contact"],
    ["leadId", "Lead"],
  ])("POST rejects a %s from another workspace with 400", async (field, label) => {
    const { POST } = await import("@/app/api/deals/route");
    const res = await POST(post({ name: "Big deal", [field]: "foreign_id" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`${label} not found in this workspace.`);
    expect(prismaMocks.deal.create).not.toHaveBeenCalled();
  });

  it("looks ids up inside the session's organisation (and not soft-deleted)", async () => {
    prismaMocks.company.findFirst.mockResolvedValueOnce({ id: "co_1" });
    prismaMocks.contact.findFirst.mockResolvedValueOnce({ id: "ct_1" });
    prismaMocks.lead.findFirst.mockResolvedValueOnce({ id: "ld_1" });
    const { POST } = await import("@/app/api/deals/route");
    const res = await POST(post({ name: "Big deal", companyId: "co_1", contactId: "ct_1", leadId: "ld_1" }));
    expect(res.status).toBe(200);
    for (const fn of [prismaMocks.company.findFirst, prismaMocks.contact.findFirst, prismaMocks.lead.findFirst]) {
      expect((fn.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toMatchObject({
        organisationId: "org_1",
        deletedAt: null,
      });
    }
    expect(prismaMocks.deal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ companyId: "co_1", contactId: "ct_1", leadId: "ld_1", organisationId: "org_1" }),
      }),
    );
  });

  it("deals without links skip the lookups", async () => {
    const { POST } = await import("@/app/api/deals/route");
    const res = await POST(post({ name: "Solo deal" }));
    expect(res.status).toBe(200);
    expect(prismaMocks.company.findFirst).not.toHaveBeenCalled();
    expect(prismaMocks.contact.findFirst).not.toHaveBeenCalled();
    expect(prismaMocks.lead.findFirst).not.toHaveBeenCalled();
  });

  it("GET hides a mis-linked company/contact that belongs to another workspace", async () => {
    prismaMocks.deal.findMany.mockResolvedValueOnce([
      {
        id: "deal_1",
        name: "Old deal",
        company: { id: "co_x", name: "Other Co", organisationId: "org_other" },
        contact: { id: "ct_x", fullName: "Someone Else", email: "x@other.test", organisationId: "org_other" },
      },
      {
        id: "deal_2",
        name: "Good deal",
        company: { id: "co_1", name: "Our Co", organisationId: "org_1" },
        contact: { id: "ct_1", fullName: "Our Contact", email: "a@ours.test", organisationId: "org_1" },
      },
    ]);
    const { GET } = await import("@/app/api/deals/route");
    const json = await (await GET(new Request("http://localhost/api/deals"))).json();
    expect(json.deals[0].company).toBeNull();
    expect(json.deals[0].contact).toBeNull();
    expect(json.deals[1].company).toEqual({ id: "co_1", name: "Our Co" });
    expect(json.deals[1].contact).toEqual({ id: "ct_1", fullName: "Our Contact", email: "a@ours.test" });
  });
});
