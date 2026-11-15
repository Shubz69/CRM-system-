import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const prismaMocks = vi.hoisted(() => ({
  conversation: {
    findFirst: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  pipelineStage: { findFirst: vi.fn() },
  organisationMember: { findFirst: vi.fn() },
  conversationAssignment: {
    updateMany: vi.fn(async () => ({ count: 1 })),
    create: vi.fn(async () => ({ id: "asg_1" })),
  },
  note: { create: vi.fn(async () => ({ id: "note_1" })) },
  lead: { updateMany: vi.fn(async () => ({ count: 1 })) },
}));

const sessionState = vi.hoisted(() => ({ role: "OWNER" as string }));
const dispatchMock = vi.hoisted(() => vi.fn());
const expireDraftsMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/followups", () => ({ cancelPendingFollowUps: vi.fn(async () => undefined) }));
vi.mock("@/services/messaging/outbound", () => ({ dispatchOutboundMessage: dispatchMock }));
vi.mock("@/services/automation-os", () => ({ expirePendingAiDrafts: expireDraftsMock }));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = () => ({ userId: "user_1", organisationId: "org_1", role: sessionState.role });
  return {
    requirePermission: vi.fn(async () => session()),
    requirePermissionForMutation: vi.fn(async () => session()),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

const NOW = new Date("2026-11-12T10:00:10Z");

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_1",
    organisationId: "org_1",
    contactId: "contact_1",
    externalThreadId: null,
    unreadCount: 0,
    lastInboundAt: new Date(NOW.getTime() - 60_000),
    messagingWindowExpiresAt: new Date(NOW.getTime() + 3_600_000),
    humanMessagingWindowExpiresAt: new Date(NOW.getTime() + 3_600_000),
    contact: { optedOut: false, identifiers: [{ channel: "manychat", identifier: "manychat:ext_1" }] },
    messagingChannel: { provider: "manychat" },
    leads: [{ id: "lead_1", metadata: { existing: true } }],
    ...overrides,
  };
}

async function patch(body: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/conversations/[id]/route");
  const req = new NextRequest("http://localhost/api/conversations/conv_1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: "conv_1" }) });
}

describe("PATCH /api/conversations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sessionState.role = "OWNER";
    prismaMocks.conversation.findFirst.mockResolvedValue(conversationRow());
    prismaMocks.pipelineStage.findFirst.mockResolvedValue({ id: "stage_2" });
    prismaMocks.organisationMember.findFirst.mockResolvedValue({ id: "mem_2" });
    dispatchMock.mockResolvedValue({
      ok: true,
      code: "CONFIRMED",
      dispatch: { id: "disp_1", messageId: "msg_1" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scopes the client's per-message key to the conversation and forwards the activity version", async () => {
    const res = await patch({
      reply: "Hello again",
      replyIdempotencyKey: "inbox-reply:abc-123",
      expectedActivityVersion: 7,
    });
    expect(res.status).toBe(200);
    const call = dispatchMock.mock.calls[0]![0];
    expect(call.idempotencyKey).toBe("human-reply:conv_1:user_1:client:inbox-reply:abc-123");
    expect(call.expectedActivityVersion).toBe(7);
    // A person replied, so AI drafts written before this reply must not be approvable.
    expect(expireDraftsMock).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: "org_1", conversationId: "conv_1" }),
    );
  });

  it("server fallback key changes with time, so the same text sent later is not swallowed", async () => {
    await patch({ reply: "Thanks!" });
    await patch({ reply: "Thanks!" }); // same minute: a double-submit collapses
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    await patch({ reply: "Thanks!" });
    const keys = dispatchMock.mock.calls.map((c) => c[0].idempotencyKey as string);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).toMatch(/^human-reply:conv_1:user_1:[0-9a-f]{16}:\d+$/);
  });

  it("flags definite delivery failures so the client can retry with a fresh key", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, code: "FAILED" });
    const res = await patch({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k1" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.notDelivered).toBe(true);
    expect(json.error).toMatch(/not sent/i);
  });

  it("reports stale context as 409 without the notDelivered flag", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, code: "STALE_CONTEXT" });
    const res = await patch({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k2", expectedActivityVersion: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).notDelivered).toBeUndefined();
  });

  it("requires inbox:assign to reassign, and changes nothing when refused", async () => {
    sessionState.role = "SALES_AGENT"; // has inbox:write, not inbox:assign
    const res = await patch({ assignUserId: "user_2", aiPaused: true });
    expect(res.status).toBe(403);
    expect(prismaMocks.conversation.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.conversationAssignment.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.conversationAssignment.create).not.toHaveBeenCalled();
  });

  it("lets a role with inbox:assign reassign", async () => {
    sessionState.role = "MANAGER";
    const res = await patch({ assignUserId: "user_2" });
    expect(res.status).toBe(200);
    expect(prismaMocks.conversationAssignment.create).toHaveBeenCalledWith({
      data: { conversationId: "conv_1", userId: "user_2", active: true },
    });
  });

  it("Resume AI clears needsHumanReview; Pause AI sets it", async () => {
    await patch({ aiPaused: false, handlingMode: "AI" });
    expect(prismaMocks.conversation.updateMany).toHaveBeenLastCalledWith({
      where: { id: "conv_1", organisationId: "org_1" },
      data: { aiPaused: false, handlingMode: "AI", needsHumanReview: false },
    });
    await patch({ aiPaused: true, handlingMode: "PAUSED" });
    expect(prismaMocks.conversation.updateMany).toHaveBeenLastCalledWith({
      where: { id: "conv_1", organisationId: "org_1" },
      data: { aiPaused: true, handlingMode: "PAUSED", needsHumanReview: true },
    });
  });

  it("refuses stage/qualification changes on a conversation with no lead (instead of a silent ok)", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(conversationRow({ leads: [] }));
    const res = await patch({ stageId: "stage_2", note: "should not be saved" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no lead/i);
    expect(prismaMocks.lead.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.note.create).not.toHaveBeenCalled();
  });

  it("records a person's stage move and qualification on the lead so AI won't overwrite them", async () => {
    const res = await patch({ stageId: "stage_2", qualificationStatus: "QUALIFIED" });
    expect(res.status).toBe(200);
    const call = (prismaMocks.lead.updateMany.mock.calls as unknown as Array<[
      { where: unknown; data: { stageId: string; qualificationStatus: string; metadata: Record<string, unknown> } },
    ]>)[0]![0];
    expect(call.where).toEqual({ id: "lead_1", organisationId: "org_1" });
    expect(call.data.stageId).toBe("stage_2");
    expect(call.data.qualificationStatus).toBe("QUALIFIED");
    expect(call.data.metadata).toMatchObject({
      existing: true,
      stageChangedBy: "HUMAN",
      stageChangedByUserId: "user_1",
      qualificationSetBy: "HUMAN",
    });
  });

  it("only marks qualification (not stage) when just the qualification changes", async () => {
    await patch({ qualificationStatus: "DISQUALIFIED" });
    const call = (prismaMocks.lead.updateMany.mock.calls as unknown as Array<[
      { data: { stageId?: string; metadata: Record<string, unknown> } },
    ]>)[0]![0];
    expect(call.data.stageId).toBeUndefined();
    expect(call.data.metadata.qualificationSetBy).toBe("HUMAN");
    expect(call.data.metadata.stageChangedBy).toBeUndefined();
  });

  it("404s an unknown stage before writing anything", async () => {
    prismaMocks.pipelineStage.findFirst.mockResolvedValueOnce(null);
    const res = await patch({ stageId: "stage_x", aiPaused: true });
    expect(res.status).toBe(404);
    expect(prismaMocks.conversation.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.lead.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/conversations/[id] (polled by the open thread)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not write when there is nothing unread", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce({ id: "conv_1", unreadCount: 0, messages: [] });
    const { GET } = await import("@/app/api/conversations/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/conversations/conv_1"), {
      params: Promise.resolve({ id: "conv_1" }),
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("clears unread once when there is something to clear", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce({ id: "conv_1", unreadCount: 3, messages: [] });
    const { GET } = await import("@/app/api/conversations/[id]/route");
    await GET(new NextRequest("http://localhost/api/conversations/conv_1"), {
      params: Promise.resolve({ id: "conv_1" }),
    });
    expect(prismaMocks.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", organisationId: "org_1" },
      data: { unreadCount: 0 },
    });
  });
});
