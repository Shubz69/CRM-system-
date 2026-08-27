import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organisationFindUnique: vi.fn(),
  followUpCreate: vi.fn(),
  followUpUpdateMany: vi.fn(),
  qualificationFieldFindMany: vi.fn(),
  qualificationAnswerFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: { findUnique: mocks.organisationFindUnique },
    followUp: {
      create: mocks.followUpCreate,
      updateMany: mocks.followUpUpdateMany,
    },
    qualificationField: { findMany: mocks.qualificationFieldFindMany },
    qualificationAnswer: { findMany: mocks.qualificationAnswerFindMany },
  },
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(),
}));

import { scheduleFollowUps } from "@/services/followups";
import {
  classifyNoResponse,
  planFollowUpSchedule,
} from "@/services/messaging/followup-policy";
import { normalizeObjectionCategory } from "@/services/messaging/objections";
import { evaluateQualification } from "@/services/qualification";

describe("messaging follow-up and qualification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not schedule when the followUps capability is disabled", async () => {
    mocks.organisationFindUnique.mockResolvedValue({
      autopilotConfig: { followUps: "disabled" },
    });

    await expect(
      scheduleFollowUps({
        organisationId: "org-1",
        contactId: "contact-1",
        conversationId: "conversation-1",
        delaysMinutes: [60],
        maxFollowUps: 1,
        skipIfAutopilotDisabled: true,
      }),
    ).resolves.toBe(0);
    expect(mocks.followUpCreate).not.toHaveBeenCalled();
    expect(mocks.followUpUpdateMany).not.toHaveBeenCalled();
  });

  it("enforces the maximum number of follow-up attempts", () => {
    expect(
      planFollowUpSchedule({
        intent: "pricing",
        qualificationStatus: "POTENTIALLY_QUALIFIED",
        attemptNumber: 2,
        maxAttempts: 2,
        meetingBooked: false,
        optedOut: false,
      }),
    ).toEqual([]);
  });

  it("classifies stalled meeting intent as high intent", () => {
    expect(
      classifyNoResponse({
        daysSinceInbound: 2,
        wasQualified: true,
        meetingIntent: true,
        lastOutboundCount: 1,
      }),
    ).toBe("HIGH_INTENT_STALLED");
  });

  it("returns missing required qualification fields", async () => {
    const fields = [
      {
        id: "field-budget",
        key: "budget",
        required: true,
        disqualifyingAnswers: [],
      },
    ];
    mocks.qualificationFieldFindMany.mockResolvedValue(fields);
    mocks.qualificationAnswerFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      evaluateQualification({ organisationId: "org-1", leadId: "lead-1" }),
    ).resolves.toEqual({
      status: "NEEDS_INFORMATION",
      reasons: ["Missing required fields: budget"],
      missingFields: ["budget"],
    });
  });

  it("normalizes price objections", () => {
    expect(normalizeObjectionCategory("price")).toBe("PRICE");
    expect(normalizeObjectionCategory("too expensive")).toBe("PRICE");
    expect(normalizeObjectionCategory("cost")).toBe("PRICE");
  });
});
