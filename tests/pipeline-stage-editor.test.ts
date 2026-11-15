import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "./helpers/fake-crm-db";
import {
  defaultInsertPosition,
  isSystemStageSlug,
  slugifyStageName,
  uniqueStageSlug,
} from "@/app/api/pipeline/_lib/stages";
import { brokenFunnelPair } from "@/lib/pipeline-funnel";

const sessionState = vi.hoisted(() => ({ role: "OWNER" as string, organisationId: "org_1" }));
const auditMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/db", async () => ({ prisma: (await import("./helpers/fake-crm-db")).fakeDb.prisma }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: auditMock }));
vi.mock("@/lib/session", async () => {
  const { roleHasPermission } = await vi.importActual<typeof import("@/lib/permissions")>(
    "@/lib/permissions",
  );
  class WorkspaceChangedError extends Error {}
  const guard = async (permission: string) => {
    if (!roleHasPermission(sessionState.role as never, permission as never)) {
      throw new Error(`Forbidden: missing permission ${permission}`);
    }
    return { userId: "user_1", organisationId: sessionState.organisationId, role: sessionState.role };
  };
  return {
    requirePermission: vi.fn(guard),
    requirePermissionForMutation: vi.fn(guard),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

const STAGES_ORG1 = [
  { id: "st_new", slug: "new", name: "New", position: 0 },
  { id: "st_engaged", slug: "engaged", name: "Engaged", position: 1 },
  { id: "st_qualified", slug: "qualified", name: "Qualified", position: 2 },
  { id: "st_proposal", slug: "proposal", name: "Proposal", position: 3 },
  { id: "st_won", slug: "won", name: "Won", position: 4, isWon: true },
  { id: "st_dq", slug: "disqualified", name: "Disqualified", position: 5, isLost: true },
];

function seed() {
  fakeDb.reset();
  fakeDb.seed("pipeline", [
    { id: "pipe_1", organisationId: "org_1", name: "Default", isDefault: true },
    { id: "pipe_2", organisationId: "org_2", name: "Default", isDefault: true },
  ]);
  fakeDb.seed(
    "pipelineStage",
    [
      ...STAGES_ORG1.map((s) => ({ ...s, pipelineId: "pipe_1" })),
      { id: "st_other", slug: "custom_other", name: "Theirs", position: 0, pipelineId: "pipe_2" },
    ],
  );
  fakeDb.seed("contact", [
    { id: "c_live", organisationId: "org_1", deletedAt: null },
    { id: "c_gone", organisationId: "org_1", deletedAt: new Date("2026-02-01") },
  ]);
  fakeDb.seed("lead", [
    { id: "lead_live", organisationId: "org_1", contactId: "c_live", stageId: "st_proposal", deletedAt: null, metadata: {} },
    { id: "lead_archived", organisationId: "org_1", contactId: "c_live", stageId: "st_proposal", deletedAt: new Date("2026-02-01"), metadata: {} },
    { id: "lead_ghost", organisationId: "org_1", contactId: "c_gone", stageId: "st_proposal", deletedAt: null, metadata: {} },
  ]);
}

function stagesOf(pipelineId: string) {
  return fakeDb.tables.pipelineStage
    .filter((s) => s.pipelineId === pipelineId)
    .sort((a, b) => (a.position as number) - (b.position as number));
}

function expectContiguous(pipelineId: string) {
  expect(stagesOf(pipelineId).map((s) => s.position)).toEqual(
    stagesOf(pipelineId).map((_, index) => index),
  );
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createStage(body: unknown) {
  const { POST } = await import("@/app/api/pipeline/stages/route");
  return POST(jsonRequest("/api/pipeline/stages", "POST", body));
}

async function reorder(body: unknown) {
  const { PATCH } = await import("@/app/api/pipeline/stages/route");
  return PATCH(jsonRequest("/api/pipeline/stages", "PATCH", body));
}

async function patchStage(id: string, body: unknown) {
  const { PATCH } = await import("@/app/api/pipeline/stages/[id]/route");
  return PATCH(jsonRequest(`/api/pipeline/stages/${id}`, "PATCH", body), {
    params: Promise.resolve({ id }),
  });
}

async function deleteStage(id: string, moveLeadsTo?: string) {
  const { DELETE } = await import("@/app/api/pipeline/stages/[id]/route");
  const query = moveLeadsTo ? `?moveLeadsTo=${moveLeadsTo}` : "";
  return DELETE(jsonRequest(`/api/pipeline/stages/${id}${query}`, "DELETE"), {
    params: Promise.resolve({ id }),
  });
}

describe("stage rules", () => {
  it("derives slugs from names and never reuses a system or taken slug", () => {
    expect(slugifyStageName("Proposal Sent!")).toBe("proposal_sent");
    expect(slugifyStageName("Café  Visit")).toBe("cafe_visit");
    expect(slugifyStageName("!!!")).toBe("stage");
    expect(uniqueStageSlug("Proposal", ["proposal"])).toBe("proposal_2");
    // A custom "Lost" stage must not start receiving cancelled bookings (webhook looks up "lost").
    expect(uniqueStageSlug("Lost", [])).toBe("lost_2");
    expect(uniqueStageSlug("Booked", ["booked"])).toBe("booked_2");
    expect(isSystemStageSlug("booking_offered")).toBe(true);
    expect(isSystemStageSlug("proposal")).toBe(false);
  });

  it("puts new stages before the closing won/lost stages", () => {
    expect(
      defaultInsertPosition([
        { isWon: false, isLost: false },
        { isWon: true, isLost: false },
        { isWon: false, isLost: true },
      ]),
    ).toBe(1);
    expect(defaultInsertPosition([])).toBe(0);
  });

  it("flags a reorder that puts a built-in funnel stage above an earlier one", () => {
    const current = ["new", "contacted", "proposal", "qualified", "won", "disqualified"];
    // Custom and lost-type stages can go anywhere.
    expect(brokenFunnelPair(current, ["proposal", "disqualified", "new", "contacted", "qualified", "won"])).toBeNull();
    expect(brokenFunnelPair(current, ["contacted", "new", "proposal", "qualified", "won", "disqualified"])).toEqual([
      "new",
      "contacted",
    ]);
    expect(brokenFunnelPair(current, ["new", "won", "contacted", "proposal", "qualified", "disqualified"])).toEqual([
      "contacted",
      "won",
    ]);
    // An order that was already broken may be repaired (and left as broken), never made worse.
    const broken = ["contacted", "new", "won"];
    expect(brokenFunnelPair(broken, ["new", "contacted", "won"])).toBeNull();
    expect(brokenFunnelPair(broken, ["contacted", "new", "won"])).toBeNull();
    expect(brokenFunnelPair(broken, ["contacted", "won", "new"])).toEqual(["new", "won"]);
  });
});

describe("POST /api/pipeline/stages", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "OWNER";
    sessionState.organisationId = "org_1";
  });

  it("adds a custom stage with a derived slug before Won/Disqualified, keeping positions contiguous", async () => {
    const res = await createStage({ name: "  Deposit paid ", color: "#22c55e" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.stage).toMatchObject({
      name: "Deposit paid",
      slug: "deposit_paid",
      color: "#22c55e",
      position: 4,
      isSystem: false,
    });
    expect(stagesOf("pipe_1").map((s) => s.slug)).toEqual([
      "new",
      "engaged",
      "qualified",
      "proposal",
      "deposit_paid",
      "won",
      "disqualified",
    ]);
    expectContiguous("pipe_1");
    // The pipeline row is locked so concurrent edits can't interleave positions.
    expect(fakeDb.prisma.$queryRaw).toHaveBeenCalled();
    // Another workspace's pipeline is untouched.
    expect(stagesOf("pipe_2")).toHaveLength(1);
  });

  it("honours an explicit position", async () => {
    const res = await createStage({ name: "First touch", position: 0 });
    expect(res.status).toBe(201);
    expect(stagesOf("pipe_1")[0]!.slug).toBe("first_touch");
    expectContiguous("pipe_1");
  });

  it("rejects duplicate names, bad input and both-won-and-lost with readable messages", async () => {
    const dup = await createStage({ name: "qualified" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toContain("already exists");

    const empty = await createStage({ name: "   " });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("Stage name is required");

    const color = await createStage({ name: "X", color: "red" });
    expect(color.status).toBe(400);
    expect((await color.json()).error).toContain("hex");

    const both = await createStage({ name: "Y", isWon: true, isLost: true });
    expect(both.status).toBe(400);
    expect((await both.json()).error).toBe("A stage can't be both won and lost");
    expect(stagesOf("pipe_1")).toHaveLength(6);
  });

  it("requires pipeline:manage", async () => {
    sessionState.role = "SALES_AGENT";
    const res = await createStage({ name: "Nope" });
    expect(res.status).toBe(403);
    expect(stagesOf("pipe_1")).toHaveLength(6);
  });

  it("404s with a clear message when the workspace has no default pipeline", async () => {
    sessionState.organisationId = "org_without_pipeline";
    const res = await createStage({ name: "Anything" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no default pipeline");
  });
});

describe("PATCH /api/pipeline/stages/[id]", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "MANAGER";
    sessionState.organisationId = "org_1";
  });

  it("renames a system stage without ever changing its slug", async () => {
    const res = await patchStage("st_qualified", { name: "Hot lead", color: "#f97316" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stage).toMatchObject({ name: "Hot lead", slug: "qualified", color: "#f97316", isSystem: true });
    const row = fakeDb.tables.pipelineStage.find((s) => s.id === "st_qualified")!;
    expect(row.slug).toBe("qualified");
    for (const call of fakeDb.prisma.pipelineStage.update.mock.calls) {
      expect(Object.keys((call[0] as { data: object }).data)).not.toContain("slug");
    }
    // Even a slug sent by the client is ignored.
    await patchStage("st_proposal", { name: "Quote sent", slug: "hacked" });
    expect(fakeDb.tables.pipelineStage.find((s) => s.id === "st_proposal")!.slug).toBe("proposal");
  });

  it("keeps won and lost mutually exclusive on custom stages", async () => {
    await patchStage("st_proposal", { isLost: true });
    let row = fakeDb.tables.pipelineStage.find((s) => s.id === "st_proposal")!;
    expect([row.isWon, row.isLost]).toEqual([false, true]);
    await patchStage("st_proposal", { isWon: true });
    row = fakeDb.tables.pipelineStage.find((s) => s.id === "st_proposal")!;
    expect([row.isWon, row.isLost]).toEqual([true, false]);
  });

  it("refuses to change won/lost on built-in stages", async () => {
    const res = await patchStage("st_won", { isWon: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("built-in");
    const lost = await patchStage("st_engaged", { isLost: true });
    expect(lost.status).toBe(400);
    expect(fakeDb.tables.pipelineStage.find((s) => s.id === "st_won")!.isWon).toBe(true);
  });

  it("rejects another workspace's stage id and duplicate names", async () => {
    const foreign = await patchStage("st_other", { name: "Mine now" });
    expect(foreign.status).toBe(404);
    expect(fakeDb.tables.pipelineStage.find((s) => s.id === "st_other")!.name).toBe("Theirs");

    const dup = await patchStage("st_proposal", { name: "WON" });
    expect(dup.status).toBe(409);

    const nothing = await patchStage("st_proposal", {});
    expect(nothing.status).toBe(400);
  });
});

describe("PATCH /api/pipeline/stages (reorder)", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "ADMINISTRATOR";
    sessionState.organisationId = "org_1";
  });

  it("applies the new order with contiguous positions", async () => {
    // Custom and disqualified stages move freely around the built-in funnel.
    const order = ["st_proposal", "st_new", "st_engaged", "st_dq", "st_qualified", "st_won"];
    const res = await reorder({ stageIds: order });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stages.map((s: { id: string }) => s.id)).toEqual(order);
    expect(stagesOf("pipe_1").map((s) => s.id)).toEqual(order);
    expectContiguous("pipe_1");
  });

  it("refuses to put a built-in funnel stage above an earlier one (the AI only moves leads forward)", async () => {
    const before = stagesOf("pipe_1").map((s) => s.id);
    const res = await reorder({ stageIds: ["st_engaged", "st_new", "st_qualified", "st_proposal", "st_won", "st_dq"] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("FUNNEL_ORDER");
    expect(body.error).toContain('"Engaged" can\'t go above "New"');
    expect(body.error).toContain("New → Engaged → Qualified → Won");
    expect(stagesOf("pipe_1").map((s) => s.id)).toEqual(before);
    expect(fakeDb.prisma.pipelineStage.update).not.toHaveBeenCalled();

    const wonFirst = await reorder({ stageIds: ["st_won", "st_new", "st_engaged", "st_qualified", "st_proposal", "st_dq"] });
    expect(wonFirst.status).toBe(400);
  });

  it("rejects missing, duplicated or foreign ids without changing anything", async () => {
    const before = stagesOf("pipe_1").map((s) => s.id);
    const ids = before.slice();
    for (const stageIds of [
      ids.slice(1),
      [...ids.slice(1), ids[1]],
      [...ids.slice(1), "st_other"],
    ]) {
      const res = await reorder({ stageIds });
      expect(res.status).toBe(400);
    }
    expect(stagesOf("pipe_1").map((s) => s.id)).toEqual(before);
    expect(fakeDb.prisma.pipelineStage.update).not.toHaveBeenCalled();

    const bad = await reorder({ stageIds: "nope" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("stageIds must be a list of stage ids");
  });
});

describe("DELETE /api/pipeline/stages/[id]", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "OWNER";
    sessionState.organisationId = "org_1";
  });

  it("never deletes a system stage", async () => {
    fakeDb.tables.lead.length = 0;
    const res = await deleteStage("st_engaged");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SYSTEM_STAGE" });
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_engaged")).toBe(true);
  });

  it("requires moveLeadsTo while the stage still has live leads (archived/deleted-contact leads don't count)", async () => {
    const res = await deleteStage("st_proposal");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STAGE_HAS_LEADS", leadCount: 1 });
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_proposal")).toBe(true);
  });

  it("rejects a destination in another workspace or the stage itself", async () => {
    expect((await deleteStage("st_proposal", "st_other")).status).toBe(404);
    expect((await deleteStage("st_proposal", "st_proposal")).status).toBe(400);
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_proposal")).toBe(true);
    expect(fakeDb.tables.lead.find((l) => l.id === "lead_live")!.stageId).toBe("st_proposal");
  });

  it("moves every lead to the destination, deletes the stage and closes the position gap", async () => {
    const res = await deleteStage("st_proposal", "st_qualified");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, movedLeads: 3, movedTo: "st_qualified" });
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_proposal")).toBe(false);
    for (const lead of fakeDb.tables.lead) expect(lead.stageId).toBe("st_qualified");
    expectContiguous("pipe_1");
    expect(stagesOf("pipe_1").map((s) => s.slug)).toEqual([
      "new",
      "engaged",
      "qualified",
      "won",
      "disqualified",
    ]);
    // Timeline: one stage_changed entry per live lead that moved.
    const activities = fakeDb.tables.crmActivity;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      organisationId: "org_1",
      kind: "stage_changed",
      leadId: "lead_live",
      contactId: "c_live",
      createdByUserId: "user_1",
      title: "Moved to Qualified",
    });
  });

  it("without live leads, moves archived and deleted-contact leads to the \"new\" stage before deleting", async () => {
    fakeDb.tables.lead.splice(fakeDb.tables.lead.findIndex((l) => l.id === "lead_live"), 1);
    const res = await deleteStage("st_proposal");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, movedLeads: 2, movedTo: "st_new" });
    // None left stageless (the FK would have set them to null).
    for (const lead of fakeDb.tables.lead) expect(lead.stageId).toBe("st_new");
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_proposal")).toBe(false);
    // Nothing the board shows moved, so no timeline entries.
    expect(fakeDb.tables.crmActivity).toHaveLength(0);
  });

  it("falls back to the first remaining stage when there is no \"new\" stage", async () => {
    fakeDb.tables.lead.splice(fakeDb.tables.lead.findIndex((l) => l.id === "lead_live"), 1);
    fakeDb.tables.pipelineStage.splice(fakeDb.tables.pipelineStage.findIndex((s) => s.id === "st_new"), 1);
    const res = await deleteStage("st_proposal");
    expect(await res.json()).toMatchObject({ movedLeads: 2, movedTo: "st_engaged" });
    for (const lead of fakeDb.tables.lead) expect(lead.stageId).toBe("st_engaged");
  });

  it("deletes an empty custom stage without a destination", async () => {
    await createStage({ name: "Temporary" });
    const temp = fakeDb.tables.pipelineStage.find((s) => s.slug === "temporary")!;
    const res = await deleteStage(temp.id as string);
    expect(res.status).toBe(200);
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === temp.id)).toBe(false);
    expectContiguous("pipe_1");
  });

  it("can't delete another workspace's stage", async () => {
    const res = await deleteStage("st_other");
    expect(res.status).toBe(404);
    expect(fakeDb.tables.pipelineStage.some((s) => s.id === "st_other")).toBe(true);
  });

  it("requires pipeline:manage", async () => {
    sessionState.role = "SALES_AGENT";
    expect((await deleteStage("st_proposal", "st_new")).status).toBe(403);
  });
});
