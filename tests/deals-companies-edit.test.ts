/**
 * Deals: currency picker (default = the workspace's most-used currency, else GBP), edit of
 * name / value / currency / stage / probability / company / contact through org-checked links,
 * soft delete. Companies: edit and soft delete (their deals and contacts keep working).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const mocks = {
    company: {
      findFirst: vi.fn(),
      update: vi.fn(async () => ({ id: "co_1" })),
    },
    contact: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    lead: { findFirst: vi.fn() },
    deal: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "deal_new", ...args.data })),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => [] as unknown[]),
      update: vi.fn(async () => ({ id: "deal_1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      groupBy: vi.fn(async () => [] as unknown[]),
    },
    crmActivity: {
      create: vi.fn(async () => ({ id: "act_1" })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(),
  };
  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks));
  return mocks;
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/domain-events/append", () => ({ appendDomainEvent: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = { userId: "user_1", organisationId: "org_1", role: "SALES_AGENT" };
  return {
    requirePermission: vi.fn(async () => session),
    requirePermissionForMutation: vi.fn(async () => session),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

import { DELETE as deleteDeal, GET as listDeals, PATCH as patchDeal, POST as createDealRoute } from "@/app/api/deals/route";
import { DELETE as deleteCompany, PATCH as patchCompany } from "@/app/api/companies/[id]/route";

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const existingDeal = {
  id: "deal_1",
  organisationId: "org_1",
  name: "Bridal package",
  status: "OPEN",
  amountCents: 50000,
  currency: "USD",
  probability: null,
  stageLabel: null,
  summary: null,
  contactId: "ct_1",
  leadId: null,
  companyId: null,
};

function activities() {
  return db.crmActivity.create.mock.calls.map((c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.deal.findFirst.mockResolvedValue(existingDeal);
  db.deal.groupBy.mockResolvedValue([]);
  db.company.findFirst.mockResolvedValue(null);
  db.contact.findFirst.mockResolvedValue(null);
});

describe("deal currency", () => {
  it("new deals default to the workspace's most-used currency", async () => {
    db.deal.groupBy.mockResolvedValue([
      { currency: "USD", _count: { _all: 1 } },
      { currency: "EUR", _count: { _all: 4 } },
    ]);
    const res = await createDealRoute(jsonRequest("http://localhost/api/deals", "POST", { name: "Venue hire" }));
    expect(res.status).toBe(200);
    expect(db.deal.create.mock.calls[0]![0].data.currency).toBe("EUR");
    expect(activities()[0]!.metadata).toMatchObject({ currency: "EUR" });
  });

  it("…or GBP when the workspace has no deals yet (never hard-wired USD)", async () => {
    await createDealRoute(jsonRequest("http://localhost/api/deals", "POST", { name: "First deal" }));
    expect(db.deal.create.mock.calls[0]![0].data.currency).toBe("GBP");
  });

  it("an explicit currency wins and is normalised", async () => {
    await createDealRoute(jsonRequest("http://localhost/api/deals", "POST", { name: "Deal", currency: "eur" }));
    expect(db.deal.create.mock.calls[0]![0].data.currency).toBe("EUR");
  });

  it("a nonsense currency is a readable 400", async () => {
    const res = await createDealRoute(jsonRequest("http://localhost/api/deals", "POST", { name: "Deal", currency: "pounds" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid currency/);
    expect(db.deal.create).not.toHaveBeenCalled();
  });

  it("the list tells the picker which currency to start on", async () => {
    db.deal.groupBy.mockResolvedValue([{ currency: "GBP", _count: { _all: 2 } }]);
    const json = await (await listDeals(new Request("http://localhost/api/deals"))).json();
    expect(json.defaultCurrency).toBe("GBP");
    expect(json.currencies).toContain("GBP");
  });
});

describe("PATCH /api/deals — edit", () => {
  it("edits name, value, currency, stage, probability and re-links an own company", async () => {
    db.company.findFirst.mockResolvedValue({ id: "co_1" });
    const res = await patchDeal(
      jsonRequest("http://localhost/api/deals", "PATCH", {
        id: "deal_1",
        name: "Bridal package — premium",
        amountCents: 75000,
        currency: "gbp",
        stageLabel: "Proposal",
        probability: 0.6,
        companyId: "co_1",
      }),
    );
    expect(res.status).toBe(200);
    expect((db.company.findFirst.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toMatchObject({
      id: "co_1",
      organisationId: "org_1",
      deletedAt: null,
    });
    expect(db.deal.update).toHaveBeenCalledWith({
      where: { id: "deal_1" },
      data: expect.objectContaining({
        name: "Bridal package — premium",
        amountCents: 75000,
        currency: "GBP",
        stageLabel: "Proposal",
        probability: 0.6,
        companyId: "co_1",
      }),
    });
    const [activity] = activities();
    expect(activity).toMatchObject({
      kind: "deal_updated",
      title: "Deal updated: Bridal package — premium",
      dealId: "deal_1",
      companyId: "co_1",
      createdByUserId: "user_1",
    });
    expect(Object.keys((activity!.metadata as { changes: object }).changes).sort()).toEqual(
      ["amountCents", "companyId", "currency", "name", "probability", "stageLabel"].sort(),
    );
  });

  it("refuses a company or contact from another workspace", async () => {
    const res = await patchDeal(jsonRequest("http://localhost/api/deals", "PATCH", { id: "deal_1", companyId: "foreign" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Company not found in this workspace.");
    const res2 = await patchDeal(jsonRequest("http://localhost/api/deals", "PATCH", { id: "deal_1", contactId: "foreign" }));
    expect((await res2.json()).error).toBe("Contact not found in this workspace.");
    expect(db.deal.update).not.toHaveBeenCalled();
    expect(activities()).toEqual([]);
  });

  it("unlinking needs no lookup and is recorded", async () => {
    const res = await patchDeal(jsonRequest("http://localhost/api/deals", "PATCH", { id: "deal_1", contactId: null }));
    expect(res.status).toBe(200);
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    expect(db.deal.update.mock.calls[0]![0].data.contactId).toBeNull();
    expect(activities()[0]!.metadata).toEqual({ changes: { contactId: { from: "ct_1", to: null } } });
  });

  it("another workspace's deal is a 404", async () => {
    db.deal.findFirst.mockResolvedValueOnce(null);
    const res = await patchDeal(jsonRequest("http://localhost/api/deals", "PATCH", { id: "other", name: "x" }));
    expect(res.status).toBe(404);
    expect((db.deal.findFirst.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toMatchObject({
      organisationId: "org_1",
      deletedAt: null,
    });
  });
});

describe("DELETE /api/deals", () => {
  it("soft-deletes inside the workspace and records it on the timeline", async () => {
    const res = await deleteDeal(jsonRequest("http://localhost/api/deals?id=deal_1", "DELETE"));
    expect(res.status).toBe(200);
    expect(db.deal.updateMany).toHaveBeenCalledWith({
      where: { id: "deal_1", organisationId: "org_1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(activities()[0]).toMatchObject({ kind: "deal_updated", title: "Deal deleted: Bridal package", dealId: "deal_1" });
  });

  it("another workspace's deal is a 404 and nothing changes", async () => {
    db.deal.findFirst.mockResolvedValueOnce(null);
    const res = await deleteDeal(jsonRequest("http://localhost/api/deals?id=other", "DELETE"));
    expect(res.status).toBe(404);
    expect(db.deal.updateMany).not.toHaveBeenCalled();
  });
});

describe("companies — edit and delete", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const company = {
    id: "co_1",
    organisationId: "org_1",
    name: "Acme",
    domain: null,
    website: null,
    industry: null,
    sizeBand: null,
    metadata: {},
  };

  it("edits a company's details", async () => {
    db.company.findFirst
      .mockResolvedValueOnce(company) // the company
      .mockResolvedValueOnce(null) // no live name clash
      .mockResolvedValueOnce(null); // no deleted row holding the name
    const res = await patchCompany(
      jsonRequest("http://localhost/api/companies/co_1", "PATCH", { name: "Acme Ltd", industry: "Events" }),
      params("co_1"),
    );
    expect(res.status).toBe(200);
    expect(db.company.update).toHaveBeenCalledWith({
      where: { id: "co_1" },
      data: expect.objectContaining({ name: "Acme Ltd", industry: "Events" }),
    });
  });

  it("a name another live company already uses is a 409", async () => {
    db.company.findFirst.mockResolvedValueOnce(company).mockResolvedValueOnce({ id: "co_2" });
    const res = await patchCompany(
      jsonRequest("http://localhost/api/companies/co_1", "PATCH", { name: "Globex" }),
      params("co_1"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('A company called "Globex" already exists.');
    expect(db.company.update).not.toHaveBeenCalled();
  });

  it("deleting soft-deletes and unlinks its deals and contacts (they keep working)", async () => {
    db.company.findFirst.mockResolvedValueOnce(company);
    db.deal.findMany.mockResolvedValueOnce([{ id: "deal_1" }, { id: "deal_2" }]);
    db.contact.findMany.mockResolvedValueOnce([{ id: "ct_1" }]);
    const res = await deleteCompany(jsonRequest("http://localhost/api/companies/co_1", "DELETE"), params("co_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, unlinkedDeals: 2, unlinkedContacts: 1 });
    expect(db.deal.updateMany).toHaveBeenCalledWith({
      where: { organisationId: "org_1", id: { in: ["deal_1", "deal_2"] } },
      data: { companyId: null },
    });
    expect(db.contact.updateMany).toHaveBeenCalledWith({
      where: { organisationId: "org_1", id: { in: ["ct_1"] } },
      data: { companyId: null },
    });
    expect(db.company.update).toHaveBeenCalledWith({
      where: { id: "co_1" },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    const recorded = (db.crmActivity.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>> }])[0].data;
    expect(recorded.map((a) => a.dealId)).toEqual(["deal_1", "deal_2"]);
    expect(recorded[0]).toMatchObject({ kind: "deal_updated", organisationId: "org_1" });
  });

  it("another workspace's company is a 404 and nothing changes", async () => {
    db.company.findFirst.mockResolvedValueOnce(null);
    const res = await deleteCompany(jsonRequest("http://localhost/api/companies/co_x", "DELETE"), params("co_x"));
    expect(res.status).toBe(404);
    expect((db.company.findFirst.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toMatchObject({
      id: "co_x",
      organisationId: "org_1",
      deletedAt: null,
    });
    expect(db.company.update).not.toHaveBeenCalled();
    expect(db.deal.updateMany).not.toHaveBeenCalled();
  });
});
