import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "./helpers/fake-crm-db";
import { aiMayMoveStage } from "@/services/lead-stage-guard";

const sessionState = vi.hoisted(() => ({ role: "SALES_AGENT" as string }));
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
    return { userId: "user_1", organisationId: "org_1", role: sessionState.role };
  };
  return {
    requirePermission: vi.fn(guard),
    requirePermissionForMutation: vi.fn(guard),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

function seed() {
  fakeDb.reset();
  fakeDb.seed("pipeline", [
    { id: "pipe_1", organisationId: "org_1", name: "Default", isDefault: true },
    { id: "pipe_2", organisationId: "org_2", name: "Default", isDefault: true },
  ]);
  fakeDb.seed("pipelineStage", [
    { id: "st_new", pipelineId: "pipe_1", slug: "new", name: "New", position: 0 },
    { id: "st_engaged", pipelineId: "pipe_1", slug: "engaged", name: "Engaged", position: 1 },
    { id: "st_qualified", pipelineId: "pipe_1", slug: "qualified", name: "Qualified", position: 2 },
    { id: "st_other", pipelineId: "pipe_2", slug: "new", name: "Theirs", position: 0 },
  ]);
  fakeDb.seed("lead", [
    { id: "l1", organisationId: "org_1", contactId: "c1", stageId: "st_new", deletedAt: null, metadata: { source: "ig" } },
    { id: "l2", organisationId: "org_1", contactId: "c2", stageId: "st_engaged", deletedAt: null, metadata: {} },
    { id: "l3", organisationId: "org_1", contactId: "c3", stageId: "st_qualified", deletedAt: null, metadata: {} },
    { id: "l_deleted", organisationId: "org_1", contactId: "c4", stageId: "st_new", deletedAt: new Date(), metadata: {} },
    { id: "l_foreign", organisationId: "org_2", contactId: "c9", stageId: "st_other", deletedAt: null, metadata: {} },
  ]);
}

function lead(id: string) {
  return fakeDb.tables.lead.find((l) => l.id === id)!;
}

/**
 * An AI analysis that commits while the move waits for its row lock: the move must re-read
 * metadata after the lock instead of writing back the copy it read before.
 */
function aiWritesWhileWaitingForLock(id: string) {
  fakeDb.prisma.$queryRaw.mockImplementationOnce((async (strings: TemplateStringsArray) => {
    expect(strings.join("?")).toContain("FOR UPDATE");
    const row = lead(id);
    row.metadata = { ...(row.metadata as object), crmMemory: { budget: "5k" }, lastAiScore: 72, stageChangedBy: "AI" };
    return [];
  }) as never);
}

async function bulk(body: unknown) {
  const { POST } = await import("@/app/api/pipeline/bulk/route");
  return POST(
    new NextRequest("http://localhost/api/pipeline/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/pipeline/bulk", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "SALES_AGENT";
  });

  it("moves the workspace's leads, marks them human-set and reports counts", async () => {
    const res = await bulk({
      leadIds: ["l1", "l2", "l3", "l_deleted", "l_foreign", "l1"],
      stageId: "st_qualified",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, moved: 2, unchanged: 1, notFound: 2 });

    for (const id of ["l1", "l2"]) {
      const row = lead(id);
      expect(row.stageId).toBe("st_qualified");
      expect(row.metadata).toMatchObject({ stageChangedBy: "HUMAN", stageChangedByUserId: "user_1" });
      // The AI may no longer move a lead a person placed.
      expect(
        aiMayMoveStage({
          current: { id: "st_qualified", slug: "qualified", position: 2 },
          target: { id: "st_x", slug: "booking_offered", position: 5 },
          metadata: row.metadata,
        }),
      ).toBe(false);
    }
    // Existing metadata is kept.
    expect(lead("l1").metadata).toMatchObject({ source: "ig" });
    // Untouched: deleted lead, another workspace's lead, the lead already in the stage.
    expect(lead("l_deleted").stageId).toBe("st_new");
    expect(lead("l_foreign").stageId).toBe("st_other");
    expect(lead("l3").metadata).toEqual({});

    const activities = fakeDb.tables.crmActivity;
    expect(activities.map((a) => a.leadId).sort()).toEqual(["l1", "l2"]);
    expect(activities[0]).toMatchObject({
      organisationId: "org_1",
      kind: "stage_changed",
      title: "Moved to Qualified",
      createdByUserId: "user_1",
    });
    expect(activities.find((a) => a.leadId === "l1")!.metadata).toMatchObject({
      fromStageId: "st_new",
      fromStageName: "New",
      toStageId: "st_qualified",
      bulk: true,
    });
    expect(fakeDb.prisma.crmActivity.createMany).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.stage_bulk_moved", organisationId: "org_1" }),
    );
  });

  it("keeps metadata the AI wrote after the leads were read (crmMemory, lastAiScore)", async () => {
    aiWritesWhileWaitingForLock("l1");
    const res = await bulk({ leadIds: ["l1", "l2"], stageId: "st_qualified" });
    expect(res.status).toBe(200);
    expect(lead("l1").metadata).toMatchObject({
      source: "ig",
      crmMemory: { budget: "5k" },
      lastAiScore: 72,
      stageChangedBy: "HUMAN",
      stageChangedByUserId: "user_1",
    });
    expect(lead("l1").stageId).toBe("st_qualified");
  });

  it("rejects another workspace's stage", async () => {
    const res = await bulk({ leadIds: ["l1"], stageId: "st_other" });
    expect(res.status).toBe(404);
    expect(lead("l1").stageId).toBe("st_new");
    expect(fakeDb.prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it("404s when none of the ids are this workspace's live leads", async () => {
    const res = await bulk({ leadIds: ["l_foreign", "missing"], stageId: "st_new" });
    expect(res.status).toBe(404);
    expect(lead("l_foreign").stageId).toBe("st_other");
  });

  it("validates the payload with readable messages", async () => {
    const tooMany = await bulk({ leadIds: Array.from({ length: 501 }, (_, i) => `x${i}`), stageId: "st_new" });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toBe("You can move at most 500 leads at once");

    const none = await bulk({ leadIds: [], stageId: "st_new" });
    expect((await none.json()).error).toBe("Select at least one lead");

    const noStage = await bulk({ leadIds: ["l1"] });
    expect(noStage.status).toBe(400);
    expect((await noStage.json()).error).toBe("stageId is required");
  });

  it("needs leads:write", async () => {
    sessionState.role = "READ_ONLY";
    const res = await bulk({ leadIds: ["l1"], stageId: "st_engaged" });
    expect(res.status).toBe(403);
    expect(lead("l1").stageId).toBe("st_new");
  });

  it("returns 400 for a malformed body", async () => {
    const { POST } = await import("@/app/api/pipeline/bulk/route");
    const res = await POST(
      new NextRequest("http://localhost/api/pipeline/bulk", { method: "POST", body: "{nope" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/pipeline (single move)", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "SALES_AGENT";
  });

  async function move(body: unknown) {
    const { PATCH } = await import("@/app/api/pipeline/route");
    return PATCH(
      new NextRequest("http://localhost/api/pipeline", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("still marks the lead human-set and now records a stage_changed activity", async () => {
    const res = await move({ leadId: "l1", stageId: "st_engaged" });
    expect(res.status).toBe(200);
    expect(lead("l1").stageId).toBe("st_engaged");
    expect(lead("l1").metadata).toMatchObject({ stageChangedBy: "HUMAN", source: "ig" });
    expect(fakeDb.tables.crmActivity).toHaveLength(1);
    expect(fakeDb.tables.crmActivity[0]).toMatchObject({
      kind: "stage_changed",
      leadId: "l1",
      contactId: "c1",
      title: "Moved to Engaged",
      metadata: { fromStageId: "st_new", fromStageName: "New", toStageId: "st_engaged" },
    });
  });

  it("keeps metadata the AI wrote after the lead was read", async () => {
    aiWritesWhileWaitingForLock("l1");
    const res = await move({ leadId: "l1", stageId: "st_engaged" });
    expect(res.status).toBe(200);
    expect(lead("l1").metadata).toMatchObject({
      source: "ig",
      crmMemory: { budget: "5k" },
      lastAiScore: 72,
      stageChangedBy: "HUMAN",
    });
  });

  it("rejects another workspace's lead or stage", async () => {
    expect((await move({ leadId: "l_foreign", stageId: "st_engaged" })).status).toBe(404);
    expect((await move({ leadId: "l1", stageId: "st_other" })).status).toBe(404);
    expect(lead("l1").stageId).toBe("st_new");
    expect(fakeDb.tables.crmActivity).toHaveLength(0);
  });

  it("returns 400 (not 500) for a missing stageId", async () => {
    const res = await move({ leadId: "l1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("stageId is required");
  });

  it("a recording failure doesn't fail the move", async () => {
    fakeDb.prisma.crmActivity.create.mockRejectedValueOnce(new Error("db down"));
    const res = await move({ leadId: "l1", stageId: "st_engaged" });
    expect(res.status).toBe(200);
    expect(lead("l1").stageId).toBe("st_engaged");
  });
});

describe("GET /api/pipeline", () => {
  beforeEach(() => seed());

  it("tells the board what this role may do and which stages are built-in", async () => {
    fakeDb.seed("pipelineStage", [
      { id: "st_custom", pipelineId: "pipe_1", slug: "deposit", name: "Deposit", position: 3 },
    ]);
    const { GET } = await import("@/app/api/pipeline/route");

    sessionState.role = "SALES_AGENT";
    let json = await (await GET()).json();
    expect(json.permissions).toEqual({ manageStages: false, moveLeads: true });
    const flags = Object.fromEntries(
      json.pipeline.stages.map((s: { slug: string; isSystem: boolean }) => [s.slug, s.isSystem]),
    );
    expect(flags).toMatchObject({ new: true, engaged: true, qualified: true, deposit: false });

    sessionState.role = "MANAGER";
    json = await (await GET()).json();
    expect(json.permissions).toEqual({ manageStages: true, moveLeads: true });

    sessionState.role = "READ_ONLY";
    json = await (await GET()).json();
    expect(json.permissions).toEqual({ manageStages: false, moveLeads: false });
  });
});
