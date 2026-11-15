/**
 * Goals: £ and % targets were saved 100× off (a £5,000 target showed "£50", 25% showed
 * "2500.0%"). KPI values are stored in the calculators' units — pence for GBP_CENTS, a 0–1
 * fraction for RATE — and the form converts at the edge. Goal API errors are plain English,
 * and revenue KPIs only add up deals in the workspace's main currency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatKpiValue,
  kpiInputAffix,
  kpiInputToStored,
  kpiStoredToInput,
} from "@/lib/customer-labels";

const mocks = vi.hoisted(() => ({
  attachKpiTarget: vi.fn(),
  updateKpiTarget: vi.fn(),
  createGoal: vi.fn(),
  transitionGoalStatus: vi.fn(),
  dealGroupBy: vi.fn(),
}));

vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = { organisationId: "org_1", userId: "u1", role: "OWNER" };
  return {
    requirePermission: vi.fn(async () => session),
    requirePermissionForMutation: vi.fn(async () => session),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { deal: { groupBy: (...args: unknown[]) => mocks.dealGroupBy(...args) } },
}));

vi.mock("@/services/goals", () => ({
  attachKpiTarget: (...args: unknown[]) => mocks.attachKpiTarget(...args),
  updateKpiTarget: (...args: unknown[]) => mocks.updateKpiTarget(...args),
  createGoal: (...args: unknown[]) => mocks.createGoal(...args),
  transitionGoalStatus: (...args: unknown[]) => mocks.transitionGoalStatus(...args),
  createKpiDefinition: vi.fn(),
  createInitiative: vi.fn(),
  getGoalForOrg: vi.fn(),
  listGoals: vi.fn(),
  listKpiHistory: vi.fn(),
  refreshKpiFromCalculator: vi.fn(),
  updateGoal: vi.fn(),
}));

import { POST } from "@/app/api/goals/route";
import { InvalidGoalTransitionError } from "@/services/goals/state";
import { KPI_CALCULATORS } from "@/services/goals/calculators";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("KPI unit conversions (input → storage → display)", () => {
  it("£ targets are stored in pence and shown in pounds", () => {
    const stored = kpiInputToStored(5000, "GBP_CENTS");
    expect(stored).toBe(500000);
    expect(formatKpiValue(stored, "GBP_CENTS")).toMatch(/^£5[,.]?000$/);
    expect(kpiStoredToInput(stored, "GBP_CENTS")).toBe(5000);
    expect(kpiInputToStored(19.99, "GBP_CENTS")).toBe(1999);
  });

  it("% targets are stored as a 0–1 rate and shown as a percentage", () => {
    const stored = kpiInputToStored(25, "RATE");
    expect(stored).toBe(0.25);
    expect(formatKpiValue(stored, "RATE")).toBe("25.0%");
    expect(kpiStoredToInput(stored, "RATE")).toBe(25);
    expect(kpiInputToStored(12.5, "RATE")).toBe(0.125);
    expect(formatKpiValue(kpiInputToStored(12.5, "RATE"), "RATE")).toBe("12.5%");
  });

  it("legacy rate targets saved as typed (25 for 25%) still display as 25%, not 2500%", () => {
    expect(formatKpiValue(25, "RATE")).toBe("25.0%");
    expect(kpiStoredToInput(25, "RATE")).toBe(25);
  });

  it("counts are unchanged", () => {
    expect(kpiInputToStored(20, "COUNT")).toBe(20);
    expect(kpiStoredToInput(20, "COUNT")).toBe(20);
    expect(formatKpiValue(20, "COUNT")).toBe("20");
  });

  it("the input shows the unit it expects", () => {
    expect(kpiInputAffix("GBP_CENTS")).toEqual({ prefix: "£", suffix: "" });
    expect(kpiInputAffix("RATE")).toEqual({ prefix: "", suffix: "%" });
    expect(kpiInputAffix("COUNT")).toEqual({ prefix: "", suffix: "" });
  });
});

describe("POST /api/goals — readable errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validation problems are one plain sentence, never raw Zod JSON", async () => {
    const tooLong = await post({ action: "create_goal", name: "x".repeat(201) });
    expect(tooLong.status).toBe(400);
    const message = (await tooLong.json()).error as string;
    expect(message).toBe("Name must be 200 characters or fewer.");
    expect(message).not.toMatch(/[[{]/);

    const badTarget = await post({ action: "attach_target", goalId: "g1", targetValue: "lots" });
    expect((await badTarget.json()).error).toBe("Target must be a number.");

    const badAction = await post({ action: "explode" });
    expect((await badAction.json()).error).toBe("Action isn't one of the available options.");
  });

  it("an empty name is asked for in words", async () => {
    const res = await post({ action: "create_goal", name: "   " });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Give the goal a name.");
    expect(mocks.createGoal).not.toHaveBeenCalled();
  });

  it("an invalid status change explains itself", async () => {
    mocks.transitionGoalStatus.mockRejectedValueOnce(new InvalidGoalTransitionError("CANCELLED", "ACTIVE"));
    const res = await post({ action: "transition", goalId: "g1", status: "ACTIVE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A cancelled goal can't be changed to active.");
  });

  it("a duplicate KPI target is explained instead of a Prisma error", async () => {
    mocks.attachKpiTarget.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await post({
      action: "attach_target",
      goalId: "g1",
      kpiDefinitionId: "k1",
      targetValue: 10,
      unit: "COUNT",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This goal already has a target for that KPI.");
  });

  it("rate targets outside 0–1 are refused (they would be a percentage typed raw)", async () => {
    const res = await post({
      action: "attach_target",
      goalId: "g1",
      kpiDefinitionId: "k1",
      targetValue: 25,
      unit: "RATE",
    });
    expect(res.status).toBe(400);
    expect(mocks.attachKpiTarget).not.toHaveBeenCalled();
  });

  it("£ targets are attached in pence with their currency", async () => {
    mocks.attachKpiTarget.mockResolvedValueOnce({ id: "t1" });
    const res = await post({
      action: "attach_target",
      goalId: "g1",
      kpiDefinitionId: "k1",
      targetValue: kpiInputToStored(5000, "GBP_CENTS"),
      unit: "GBP_CENTS",
    });
    expect(res.status).toBe(200);
    expect(mocks.attachKpiTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetValue: 500000, unit: "GBP_CENTS", currency: "GBP" }),
    );
  });

  it("an existing target can be corrected (e.g. an old £5,000 target saved as £50)", async () => {
    mocks.updateKpiTarget.mockResolvedValueOnce({ id: "t1", targetValue: 500000 });
    const res = await post({
      action: "update_target",
      targetId: "t1",
      targetValue: kpiInputToStored(5000, "GBP_CENTS"),
    });
    expect(res.status).toBe(200);
    expect(mocks.updateKpiTarget).toHaveBeenCalledWith({
      organisationId: "org_1",
      targetId: "t1",
      targetValue: 500000,
    });
  });

  it("editing a target another workspace owns reads as not found", async () => {
    mocks.updateKpiTarget.mockRejectedValueOnce(new Error("KPI target not found"));
    const res = await post({ action: "update_target", targetId: "t_other", targetValue: 10 });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("KPI target not found");
  });

  it("editing a target needs a value", async () => {
    const res = await post({ action: "update_target", targetId: "t1" });
    expect(res.status).toBe(400);
    expect(mocks.updateKpiTarget).not.toHaveBeenCalled();
  });
});

describe("revenue KPIs never mix currencies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("won revenue sums the workspace's main currency only and reports the others separately", async () => {
    // 1st groupBy: WON deals by currency. 2nd: every deal by currency (main currency = GBP).
    mocks.dealGroupBy
      .mockResolvedValueOnce([
        { currency: "GBP", _sum: { amountCents: 500000 }, _count: { _all: 2 } },
        { currency: "gbp", _sum: { amountCents: 1000 }, _count: { _all: 1 } },
        { currency: "USD", _sum: { amountCents: 900000 }, _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([
        { currency: "GBP", _count: { _all: 7 } },
        { currency: "USD", _count: { _all: 3 } },
      ]);
    const result = await KPI_CALCULATORS.won_revenue_cents!.calculate("org_1");
    expect(result.unit).toBe("GBP_CENTS");
    expect(result.value).toBe(501000);
    expect(result.metadata).toMatchObject({
      wonDealCount: 3,
      currency: "GBP",
      excludedCurrencies: [{ currency: "USD", amountCents: 900000, count: 3 }],
    });
    expect(mocks.dealGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["currency"],
        where: { organisationId: "org_1", deletedAt: null, status: "WON" },
      }),
    );
  });

  it("keeps a workspace's revenue when all its deals are in the old USD default", async () => {
    mocks.dealGroupBy
      .mockResolvedValueOnce([{ currency: "USD", _sum: { amountCents: 250000 }, _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ currency: "USD", _count: { _all: 4 } }]);
    const result = await KPI_CALCULATORS.open_pipeline_cents!.calculate("org_1");
    expect(result.value).toBe(250000);
    expect(result.metadata).toMatchObject({ currency: "USD", excludedCurrencies: [] });
  });

  it("falls back to GBP for a workspace with no deals", async () => {
    mocks.dealGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await KPI_CALCULATORS.open_pipeline_cents!.calculate("org_1");
    expect(result.value).toBe(0);
    expect(result.metadata).toMatchObject({ currency: "GBP" });
  });
});

describe("money KPIs carry their own currency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a $ revenue KPI counts USD deals and is labelled USD", async () => {
    mocks.dealGroupBy.mockResolvedValueOnce([
      { currency: "USD", _sum: { amountCents: 250000 }, _count: { _all: 2 } },
      { currency: "GBP", _sum: { amountCents: 90000 }, _count: { _all: 1 } },
    ]);
    const result = await KPI_CALCULATORS.won_revenue_cents!.calculate("org_1", { unit: "USD_CENTS" });
    expect(result.unit).toBe("USD_CENTS");
    expect(result.value).toBe(250000);
    expect(result.metadata).toMatchObject({
      currency: "USD",
      excludedCurrencies: [{ currency: "GBP", amountCents: 90000, count: 1 }],
    });
    // The unit decides the currency, so the workspace's main currency isn't looked up.
    expect(mocks.dealGroupBy).toHaveBeenCalledTimes(1);
  });

  it("an existing £ KPI only counts £ deals, even in a workspace whose deals are mostly $", async () => {
    mocks.dealGroupBy.mockResolvedValueOnce([
      { currency: "USD", _sum: { amountCents: 250000 }, _count: { _all: 5 } },
    ]);
    const result = await KPI_CALCULATORS.open_pipeline_cents!.calculate("org_1", { unit: "GBP_CENTS" });
    expect(result.unit).toBe("GBP_CENTS");
    expect(result.value).toBe(0);
  });

  it("formats and labels any currency", () => {
    expect(formatKpiValue(500000, "USD_CENTS")).toMatch(/^\$5[,.]?000$/);
    expect(formatKpiValue(500000, "EUR_CENTS")).toMatch(/^€5[,.]?000$/);
    expect(formatKpiValue(500000, "AUD_CENTS")).toMatch(/^AUD 5[,.]?000$/);
    expect(kpiInputAffix("EUR_CENTS")).toEqual({ prefix: "€", suffix: "" });
    expect(kpiInputToStored(12.5, "EUR_CENTS")).toBe(1250);
  });

  it("a $ revenue KPI gets its own key so it never collides with an existing £ one", async () => {
    const { createKpiDefinition } = await import("@/services/goals");
    const create = vi.mocked(createKpiDefinition);
    create.mockResolvedValueOnce({ id: "k_usd" } as never);
    const res = await post({
      action: "create_kpi",
      key: "won_revenue_cents",
      name: "Won revenue",
      unit: "USD_CENTS",
      calculatorKey: "won_revenue_cents",
    });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ key: "won_revenue_cents_usd", unit: "USD_CENTS" }),
    );
  });
});
