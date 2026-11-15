import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  assigneeChoices,
  INBOX_LIST_MAX,
  inboxListPaging,
  threadChanged,
} from "@/app/(app)/inbox/inbox-queues";

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

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/followups", () => ({ cancelPendingFollowUps: vi.fn(async () => undefined) }));
vi.mock("@/services/messaging/outbound", () => ({ dispatchOutboundMessage: dispatchMock }));
vi.mock("@/services/automation-os", () => ({ expirePendingAiDrafts: vi.fn(async () => 0) }));
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
    leads: [],
    assignments: [],
    ...overrides,
  };
}

async function get(url: string) {
  const { GET } = await import("@/app/api/conversations/[id]/route");
  return GET(new NextRequest(url), { params: Promise.resolve({ id: "conv_1" }) });
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

type FindFirstArgs = { where: unknown; select?: Record<string, unknown>; include?: Record<string, unknown> };
const findFirstArgs = () => prismaMocks.conversation.findFirst.mock.calls[0]![0] as FindFirstArgs;

describe("GET /api/conversations/[id]?versionOnly=1 (light thread poll)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the change markers, org-scoped, and never clears unread", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce({
      activityVersion: 9,
      lastMessageAt: new Date("2026-11-12T09:00:00Z"),
      unreadCount: 4,
    });
    const res = await get("http://localhost/api/conversations/conv_1?versionOnly=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      activityVersion: 9,
      lastMessageAt: "2026-11-12T09:00:00.000Z",
      unreadCount: 4,
    });
    const args = findFirstArgs();
    expect(args.where).toEqual({ id: "conv_1", organisationId: "org_1", deletedAt: null });
    expect(args.select).toEqual({ activityVersion: true, lastMessageAt: true, unreadCount: true });
    expect(args.include).toBeUndefined();
    expect(prismaMocks.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("404s a conversation outside the workspace", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(null);
    const res = await get("http://localhost/api/conversations/conv_1?versionOnly=1");
    expect(res.status).toBe(404);
  });

  it("full read keeps the newest 500 messages, returned oldest → newest", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce({
      id: "conv_1",
      unreadCount: 0,
      // As the query returns them: newest first.
      messages: [{ id: "m3" }, { id: "m2" }, { id: "m1" }],
    });
    const res = await get("http://localhost/api/conversations/conv_1");
    const json = await res.json();
    expect(json.conversation.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(findFirstArgs().include!.messages).toEqual({ orderBy: { sentAt: "desc" }, take: 500 });
  });
});

describe("PATCH /api/conversations/[id] — assigning without inbox:assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = "SALES_AGENT"; // inbox:write, not inbox:assign
    prismaMocks.organisationMember.findFirst.mockResolvedValue({ id: "mem_1" });
  });

  it("lets an agent take an unassigned conversation themselves", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(conversationRow());
    const res = await patch({ assignUserId: "user_1" });
    expect(res.status).toBe(200);
    expect(prismaMocks.conversationAssignment.create).toHaveBeenCalledWith({
      data: { conversationId: "conv_1", userId: "user_1", active: true },
    });
  });

  it("lets an agent unassign themselves", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(
      conversationRow({ assignments: [{ userId: "user_1" }] }),
    );
    const res = await patch({ assignUserId: null });
    expect(res.status).toBe(200);
    expect(prismaMocks.conversationAssignment.updateMany).toHaveBeenCalled();
    expect(prismaMocks.conversationAssignment.create).not.toHaveBeenCalled();
  });

  it("refuses to take or unassign a conversation that belongs to someone else", async () => {
    for (const assignUserId of ["user_1", null]) {
      prismaMocks.conversation.findFirst.mockResolvedValueOnce(
        conversationRow({ assignments: [{ userId: "user_2" }] }),
      );
      const res = await patch({ assignUserId });
      expect(res.status).toBe(403);
    }
    expect(prismaMocks.conversationAssignment.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.conversationAssignment.create).not.toHaveBeenCalled();
  });

  it("refuses assigning a teammate before reading anything", async () => {
    const res = await patch({ assignUserId: "user_2" });
    expect(res.status).toBe(403);
    expect(prismaMocks.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("a manager can still reassign someone else's conversation", async () => {
    sessionState.role = "MANAGER";
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(
      conversationRow({ assignments: [{ userId: "user_2" }] }),
    );
    const res = await patch({ assignUserId: "user_3" });
    expect(res.status).toBe(200);
    expect(prismaMocks.conversationAssignment.create).toHaveBeenCalledWith({
      data: { conversationId: "conv_1", userId: "user_3", active: true },
    });
  });
});

describe("PATCH /api/conversations/[id] — refused replies are flagged notDelivered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sessionState.role = "OWNER";
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    "CONTACT_OPTED_OUT",
    "DO_NOT_CONTACT",
    "CONTACT_SUPPRESSED",
    "MESSAGING_WINDOW_CLOSED",
    "CONVERSATION_CLOSED",
    "PROVIDER_POLICY_BLOCKED",
  ])("%s → 403 with notDelivered", async (code) => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(conversationRow());
    dispatchMock.mockResolvedValueOnce({ ok: false, code });
    const res = await patch({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k1" });
    expect(res.status).toBe(403);
    expect((await res.json()).notDelivered).toBe(true);
  });

  it("a closed window caught before dispatch is also notDelivered", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(
      conversationRow({ humanMessagingWindowExpiresAt: new Date(NOW.getTime() - 1000) }),
    );
    const res = await patch({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k2" });
    expect(res.status).toBe(403);
    expect((await res.json()).notDelivered).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("an unconfirmed send (reconciliation) is not flagged", async () => {
    prismaMocks.conversation.findFirst.mockResolvedValueOnce(conversationRow());
    dispatchMock.mockResolvedValueOnce({ ok: false, code: "RECONCILIATION_REQUIRED" });
    const res = await patch({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k3" });
    expect(res.status).toBe(409);
    expect((await res.json()).notDelivered).toBeUndefined();
  });
});

describe("inbox list paging", () => {
  it("offers more while loaded < total, below the cap", () => {
    expect(inboxListPaging({ loaded: 200, total: 900, limit: 200 })).toEqual({ canLoadMore: true, capped: false });
    // Short page but rows remain (e.g. some were deleted between reads) — still offer more.
    expect(inboxListPaging({ loaded: 180, total: 900, limit: 200 })).toEqual({ canLoadMore: true, capped: false });
  });

  it("stops at the server cap and reports it", () => {
    expect(inboxListPaging({ loaded: INBOX_LIST_MAX, total: 900, limit: INBOX_LIST_MAX })).toEqual({
      canLoadMore: false,
      capped: true,
    });
  });

  it("nothing more when everything is loaded", () => {
    expect(inboxListPaging({ loaded: 42, total: 42, limit: 100 })).toEqual({ canLoadMore: false, capped: false });
    expect(inboxListPaging({ loaded: 500, total: 500, limit: 500 })).toEqual({ canLoadMore: false, capped: false });
  });
});

describe("threadChanged", () => {
  const shown = { activityVersion: 3, lastMessageAt: "2026-11-12T09:00:00.000Z" };
  it("is false when nothing moved", () => {
    expect(threadChanged(shown, { ...shown })).toBe(false);
  });
  it("is true when the version or last message moved", () => {
    expect(threadChanged(shown, { ...shown, activityVersion: 4 })).toBe(true);
    expect(threadChanged(shown, { ...shown, lastMessageAt: "2026-11-12T09:01:00.000Z" })).toBe(true);
    expect(threadChanged({ activityVersion: 0, lastMessageAt: null }, { activityVersion: 0, lastMessageAt: "x" })).toBe(true);
  });
});

describe("assigneeChoices", () => {
  const me = { id: "user_1", name: "Me Person", email: "me@x.test" };
  const other = { id: "user_2", name: null, email: "other@x.test" };
  const members = [me, other];

  it("with inbox:assign lists everyone", () => {
    const r = assigneeChoices({ canAssignAnyone: true, currentUserId: "user_1", currentAssignee: other, members });
    expect(r.locked).toBe(false);
    expect(r.options.map((o) => o.value)).toEqual(["", "user_1", "user_2"]);
  });

  it("without it offers only Me / Unassigned", () => {
    for (const currentAssignee of [null, me]) {
      const r = assigneeChoices({ canAssignAnyone: false, currentUserId: "user_1", currentAssignee, members });
      expect(r).toEqual({
        options: [
          { value: "", label: "Unassigned" },
          { value: "user_1", label: "Me" },
        ],
        locked: false,
      });
    }
  });

  it("without it, someone else's conversation is shown locked", () => {
    const r = assigneeChoices({ canAssignAnyone: false, currentUserId: "user_1", currentAssignee: other, members });
    expect(r).toEqual({ options: [{ value: "user_2", label: "other@x.test" }], locked: true });
  });
});
