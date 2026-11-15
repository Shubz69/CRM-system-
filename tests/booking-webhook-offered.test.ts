import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organisationFindFirst: vi.fn(),
  webhookEventFindUnique: vi.fn(),
  webhookEventUpsert: vi.fn(),
  webhookEventUpdate: vi.fn(),
  contactFindFirst: vi.fn(),
  contactIdentifierFindFirst: vi.fn(),
  leadFindFirst: vi.fn(),
  leadUpdateMany: vi.fn(),
  pipelineStageFindFirst: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  bookingUpsert: vi.fn(),
  cancelPendingFollowUps: vi.fn(),
  runAutomations: vi.fn(),
  notifyOnBooking: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    // No workspace-owned booking secret → the shared secret path is exercised.
    integration: { findUnique: vi.fn(async () => null) },
    organisation: { findFirst: mocks.organisationFindFirst },
    webhookEvent: {
      findUnique: mocks.webhookEventFindUnique,
      upsert: mocks.webhookEventUpsert,
      update: mocks.webhookEventUpdate,
    },
    contact: { findFirst: mocks.contactFindFirst },
    contactIdentifier: { findFirst: mocks.contactIdentifierFindFirst },
    lead: { findFirst: mocks.leadFindFirst, updateMany: mocks.leadUpdateMany },
    pipelineStage: { findFirst: mocks.pipelineStageFindFirst },
    booking: {
      findUnique: mocks.bookingFindUnique,
      findFirst: mocks.bookingFindFirst,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
      upsert: mocks.bookingUpsert,
    },
  },
}));
vi.mock("@/lib/env", () => ({
  assertProductionSecretsConfigured: () => undefined,
  getEnv: () => ({ BOOKING_WEBHOOK_SECRET: "booking-secret", BOOKING_PROVIDER: "link" }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/services/followups", () => ({
  cancelPendingFollowUps: (...args: unknown[]) => mocks.cancelPendingFollowUps(...args),
}));
vi.mock("@/services/automations", () => ({
  runAutomations: (...args: unknown[]) => mocks.runAutomations(...args),
}));
vi.mock("@/services/notifications", () => ({
  notifyOnBooking: (...args: unknown[]) => mocks.notifyOnBooking(...args),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/services/usage", () => ({ recordUsage: vi.fn() }));

import { handleBookingWebhook } from "@/services/booking-webhook";

function bookingRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/webhooks/booking", {
    method: "POST",
    headers: { "content-type": "application/json", "x-booking-secret": "booking-secret" },
    body: JSON.stringify(body),
  }) as never;
}

const confirmed = {
  organisationId: "org-1",
  event: "created",
  externalId: "cal-evt-1",
  contactEmail: "lead@example.com",
  scheduledAt: "2026-12-01T10:00:00.000Z",
};

function statusUpdates() {
  return mocks.webhookEventUpdate.mock.calls.map(
    (c) => (c[0] as { data: { status?: string } }).data.status,
  );
}

describe("booking webhook confirms the AI's OFFERED booking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BOOKING_PROVIDER;
    mocks.organisationFindFirst.mockResolvedValue({ id: "org-1" });
    mocks.webhookEventFindUnique.mockResolvedValue(null);
    mocks.webhookEventUpsert.mockResolvedValue({ id: "wh-1" });
    mocks.webhookEventUpdate.mockResolvedValue({});
    mocks.contactFindFirst.mockResolvedValue({ id: "contact-1" });
    mocks.leadFindFirst.mockResolvedValue({ id: "lead-1", conversationId: "conv-1" });
    mocks.pipelineStageFindFirst.mockResolvedValue({ id: "stage-booked" });
    mocks.leadUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingFindUnique.mockResolvedValue(null);
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.bookingUpdate.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
    }));
    mocks.bookingUpsert.mockResolvedValue({ id: "booking-new" });
    mocks.runAutomations.mockResolvedValue(0);
  });

  it("updates the OFFERED row in place instead of creating a second booking", async () => {
    mocks.bookingFindFirst.mockResolvedValue({ id: "booking-offered" });

    const res = await handleBookingWebhook(bookingRequest(confirmed));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, bookingId: "booking-offered" });
    expect(mocks.bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org-1",
          contactId: "contact-1",
          status: "OFFERED",
          externalId: null,
        }),
      }),
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-offered" },
      data: expect.objectContaining({
        provider: "link",
        externalId: "cal-evt-1",
        status: "CREATED",
      }),
    });
    expect(mocks.bookingUpsert).not.toHaveBeenCalled();
    // The old promotion stamped the externalId onto every OFFERED row → P2002.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.cancelPendingFollowUps).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" }),
    );
    expect(mocks.runAutomations).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "booking_created" }),
    );
    expect(statusUpdates()).toEqual(["PROCESSED"]);
  });

  it("upserts when there is no open offer", async () => {
    const res = await handleBookingWebhook(bookingRequest(confirmed));

    expect(res.status).toBe(200);
    expect(mocks.bookingUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("an already-tracked externalId is upserted, never re-applied to an offer", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ id: "booking-tracked" });
    mocks.bookingFindFirst.mockResolvedValue({ id: "booking-offered" });

    await handleBookingWebhook(bookingRequest({ ...confirmed, event: "rescheduled" }));

    expect(mocks.bookingFindFirst).not.toHaveBeenCalled();
    expect(mocks.bookingUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("contact not found → 404 and the event is marked IGNORED, not left PROCESSING", async () => {
    mocks.contactFindFirst.mockResolvedValue(null);

    const res = await handleBookingWebhook(bookingRequest(confirmed));

    expect(res.status).toBe(404);
    expect(statusUpdates()).toEqual(["IGNORED"]);
  });

  it("a thrown error → 500 and the event is marked FAILED", async () => {
    mocks.bookingUpsert.mockRejectedValue(new Error("db down"));

    const res = await handleBookingWebhook(bookingRequest(confirmed));

    expect(res.status).toBe(500);
    expect(statusUpdates()).toEqual(["FAILED"]);
    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: "db down" }) }),
    );
  });
});
