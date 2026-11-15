import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Best-effort CrmActivity recording where a person acts: inbox notes, replies and
 * stage/qualification changes; booking webhook outcomes; deal create/update.
 * Recording must happen only after the action succeeded and never change the response.
 */
const db = vi.hoisted(() => {
  const mocks = {
    conversation: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    pipelineStage: { findFirst: vi.fn() },
    organisationMember: { findFirst: vi.fn() },
    conversationAssignment: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "asg_1" })),
    },
    note: { create: vi.fn(async () => ({ id: "note_1" })) },
    lead: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    crmActivity: {
      create: vi.fn(async () => ({ id: "act_1" })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    company: { findFirst: vi.fn(async () => null as unknown) },
    contact: { findFirst: vi.fn() },
    deal: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "deal_1", ...args.data })),
      findFirst: vi.fn(),
      update: vi.fn(async () => ({ id: "deal_1" })),
    },
    integration: { findUnique: vi.fn(async () => null) },
    organisation: { findFirst: vi.fn() },
    webhookEvent: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    contactIdentifier: { findFirst: vi.fn() },
    booking: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  };
  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks));
  return mocks;
});
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/services/followups", () => ({ cancelPendingFollowUps: vi.fn(async () => undefined) }));
vi.mock("@/services/messaging/outbound", () => ({ dispatchOutboundMessage: dispatchMock }));
vi.mock("@/services/automation-os", () => ({ expirePendingAiDrafts: vi.fn(async () => 0) }));
vi.mock("@/services/domain-events/append", () => ({ appendDomainEvent: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/services/automations", () => ({ runAutomations: vi.fn(async () => 0) }));
vi.mock("@/services/notifications", () => ({ notifyOnBooking: vi.fn(async () => undefined) }));
vi.mock("@/services/usage", () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/env", () => ({
  assertProductionSecretsConfigured: () => undefined,
  getEnv: () => ({ BOOKING_WEBHOOK_SECRET: "booking-secret", BOOKING_PROVIDER: "link" }),
}));
vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = () => ({ userId: "user_1", organisationId: "org_1", role: "OWNER" });
  return {
    requirePermission: vi.fn(async () => session()),
    requirePermissionForMutation: vi.fn(async () => session()),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

type ActivityInput = { data: Record<string, unknown> };
function recorded(): Array<Record<string, unknown>> {
  return db.crmActivity.create.mock.calls.map((c) => (c as unknown as [ActivityInput])[0].data);
}

function conversationRow() {
  const now = Date.now();
  return {
    id: "conv_1",
    organisationId: "org_1",
    contactId: "contact_1",
    externalThreadId: null,
    lastInboundAt: new Date(now - 60_000),
    messagingWindowExpiresAt: new Date(now + 3_600_000),
    humanMessagingWindowExpiresAt: new Date(now + 3_600_000),
    contact: { optedOut: false, identifiers: [{ channel: "manychat", identifier: "manychat:ext_1" }] },
    messagingChannel: { provider: "manychat" },
    leads: [{ id: "lead_1", stageId: "stage_1", qualificationStatus: "UNKNOWN", metadata: {} }],
    assignments: [],
  };
}

async function patchConversation(body: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/conversations/[id]/route");
  return PATCH(
    new NextRequest("http://localhost/api/conversations/conv_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "conv_1" }) },
  );
}

describe("inbox actions record timeline activities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.conversation.findFirst.mockResolvedValue(conversationRow());
    db.pipelineStage.findFirst.mockResolvedValue({ id: "stage_2", name: "Qualified" });
    db.crmActivity.create.mockResolvedValue({ id: "act_1" });
    dispatchMock.mockResolvedValue({ ok: true, code: "CONFIRMED", dispatch: { id: "disp_1", messageId: "m1" } });
  });

  it("a note becomes a 'note' activity pointing at the Note row", async () => {
    const res = await patchConversation({ note: "Wants the Saturday slot" });
    expect(res.status).toBe(200);
    expect(db.note.create).toHaveBeenCalled();
    expect(recorded()).toEqual([
      expect.objectContaining({
        organisationId: "org_1",
        kind: "note",
        body: "Wants the Saturday slot",
        contactId: "contact_1",
        leadId: "lead_1",
        createdByUserId: "user_1",
        metadata: { noteId: "note_1", conversationId: "conv_1" },
      }),
    ]);
  });

  it("stage and qualification changes are recorded with from/to", async () => {
    const res = await patchConversation({ stageId: "stage_2", qualificationStatus: "QUALIFIED" });
    expect(res.status).toBe(200);
    const rows = recorded();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "stage_changed",
      title: "Moved to Qualified",
      leadId: "lead_1",
      metadata: { fromStageId: "stage_1", toStageId: "stage_2", toStageName: "Qualified" },
    });
    expect(rows[1]).toMatchObject({
      kind: "qualification_changed",
      metadata: { from: "UNKNOWN", to: "QUALIFIED" },
    });
  });

  it("re-setting the current stage/qualification records nothing", async () => {
    db.pipelineStage.findFirst.mockResolvedValue({ id: "stage_1", name: "New" });
    await patchConversation({ stageId: "stage_1", qualificationStatus: "UNKNOWN" });
    expect(db.lead.updateMany).toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });

  it("a delivered reply records 'reply_sent' with a short snippet", async () => {
    const reply = "x".repeat(400);
    const res = await patchConversation({ reply, replyIdempotencyKey: "inbox-reply:k1" });
    expect(res.status).toBe(200);
    const [row] = recorded();
    expect(row).toMatchObject({
      kind: "reply_sent",
      contactId: "contact_1",
      createdByUserId: "user_1",
      metadata: { conversationId: "conv_1", dispatchId: "disp_1" },
    });
    expect((row!.body as string).length).toBe(280);
  });

  it("failed or duplicate sends record nothing", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, code: "FAILED" });
    expect((await patchConversation({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k2" })).status).toBe(502);
    dispatchMock.mockResolvedValueOnce({ ok: true, code: "ALREADY_CONFIRMED", dispatch: { id: "disp_1" } });
    expect((await patchConversation({ reply: "Hi", replyIdempotencyKey: "inbox-reply:k3" })).status).toBe(200);
    expect(recorded()).toEqual([]);
  });

  it("a recording failure never changes the response", async () => {
    db.crmActivity.create.mockRejectedValue(new Error("timeline table locked"));
    const res = await patchConversation({ note: "Hello", stageId: "stage_2", reply: "Hi there" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(db.crmActivity.create).toHaveBeenCalledTimes(3);
  });
});

function bookingRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/webhooks/booking", {
    method: "POST",
    headers: { "content-type": "application/json", "x-booking-secret": "booking-secret" },
    body: JSON.stringify(body),
  }) as never;
}

const bookingEvent = {
  organisationId: "org-1",
  event: "rescheduled",
  externalId: "cal-evt-1",
  contactEmail: "lead@example.com",
  scheduledAt: "2026-12-01T10:00:00.000Z",
};

describe("booking webhook records a 'booking' activity for the contact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.organisation.findFirst.mockResolvedValue({ id: "org-1" });
    db.webhookEvent.findUnique.mockResolvedValue(null);
    db.webhookEvent.upsert.mockResolvedValue({ id: "wh-1" });
    db.webhookEvent.update.mockResolvedValue({});
    db.contact.findFirst.mockResolvedValue({ id: "contact-1" });
    db.lead.findFirst.mockResolvedValue({ id: "lead-1", conversationId: "conv-1" });
    db.pipelineStage.findFirst.mockResolvedValue({ id: "stage-booked", name: "Booked" });
    db.booking.findUnique.mockResolvedValue({ id: "booking-1" });
    db.booking.upsert.mockResolvedValue({ id: "booking-1", leadId: "lead-1" });
  });

  it("records the outcome once the event is processed", async () => {
    const { handleBookingWebhook } = await import("@/services/booking-webhook");
    const res = await handleBookingWebhook(bookingRequest(bookingEvent));
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([
      expect.objectContaining({
        organisationId: "org-1",
        kind: "booking",
        title: "Meeting rescheduled",
        contactId: "contact-1",
        leadId: "lead-1",
        metadata: expect.objectContaining({
          bookingId: "booking-1",
          status: "RESCHEDULED",
          scheduledAt: "2026-12-01T10:00:00.000Z",
          movedToStage: "Booked",
        }),
      }),
    ]);
  });

  it("a redelivered (already processed) event records nothing", async () => {
    db.webhookEvent.findUnique.mockResolvedValue({ status: "PROCESSED" });
    const { handleBookingWebhook } = await import("@/services/booking-webhook");
    const res = await handleBookingWebhook(bookingRequest(bookingEvent));
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(recorded()).toEqual([]);
  });

  it("a recording failure doesn't fail the webhook", async () => {
    db.crmActivity.create.mockRejectedValueOnce(new Error("nope"));
    const { handleBookingWebhook } = await import("@/services/booking-webhook");
    const res = await handleBookingWebhook(bookingRequest(bookingEvent));
    expect(res.status).toBe(200);
    const statuses = db.webhookEvent.update.mock.calls.map(
      (c) => (c as unknown as [{ data: { status?: string } }])[0].data.status,
    );
    expect(statuses).toEqual(["PROCESSED"]);
  });
});

function dealRequest(method: "POST" | "PATCH", body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/deals", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("deals record 'deal_created' / 'deal_updated'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.contact.findFirst.mockResolvedValue({ id: "ct_1" });
    db.deal.findFirst.mockResolvedValue({
      id: "deal_1",
      organisationId: "org_1",
      name: "Bridal package",
      status: "OPEN",
      amountCents: 50000,
      probability: null,
      stageLabel: null,
      summary: null,
      currency: "USD",
      contactId: "ct_1",
      leadId: "ld_1",
      companyId: null,
    });
  });

  it("creating a deal records it against the contact", async () => {
    const { POST } = await import("@/app/api/deals/route");
    const res = await POST(dealRequest("POST", { name: "Bridal package", contactId: "ct_1", amountCents: 50000 }));
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([
      expect.objectContaining({
        kind: "deal_created",
        title: "Deal created: Bridal package",
        dealId: "deal_1",
        contactId: "ct_1",
        createdByUserId: "user_1",
      }),
    ]);
  });

  it("updating a deal records only the fields that changed", async () => {
    const { PATCH } = await import("@/app/api/deals/route");
    const res = await PATCH(dealRequest("PATCH", { id: "deal_1", status: "WON", amountCents: 50000 }));
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([
      expect.objectContaining({
        kind: "deal_updated",
        title: "Deal won: Bridal package",
        dealId: "deal_1",
        contactId: "ct_1",
        leadId: "ld_1",
        metadata: { changes: { status: { from: "OPEN", to: "WON" } } },
      }),
    ]);
  });

  it("a no-op update records nothing; a failed update records nothing", async () => {
    const { PATCH } = await import("@/app/api/deals/route");
    await PATCH(dealRequest("PATCH", { id: "deal_1", amountCents: 50000 }));
    db.deal.findFirst.mockResolvedValueOnce(null);
    expect((await PATCH(dealRequest("PATCH", { id: "missing", status: "LOST" }))).status).toBe(404);
    expect(recorded()).toEqual([]);
  });
});
