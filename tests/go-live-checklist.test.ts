/**
 * Go-live checklist items are computed from real workspace state instead of hardcoded "ready".
 */
import { describe, expect, it } from "vitest";
import {
  bookingCheck,
  businessProfileCheck,
  messagingRulesCheck,
  qualificationCheck,
  scoringCheck,
} from "@/app/(app)/settings/go-live/checklist";

describe("go-live checklist", () => {
  it("qualification needs questions or fields", () => {
    expect(qualificationCheck({ agent: { qualificationQuestions: [] }, qualificationFieldCount: 0 }).status).toBe(
      "needs_attention",
    );
    expect(
      qualificationCheck({ agent: { qualificationQuestions: ["Budget?"] }, qualificationFieldCount: 0 }).status,
    ).toBe("ready");
    expect(qualificationCheck({ agent: null, qualificationFieldCount: 2 }).status).toBe("ready");
  });

  it("lead scoring needs an active, published agent configuration", () => {
    expect(scoringCheck(null).status).toBe("needs_attention");
    expect(scoringCheck(undefined).status).toBe("needs_attention");
    expect(scoringCheck({ isDraft: true }).status).toBe("needs_attention");
    expect(scoringCheck({ isDraft: false, scoringRules: {} })).toMatchObject({
      status: "ready",
      detail: "Default scoring weights in use",
    });
    expect(scoringCheck({ isDraft: false, scoringRules: { weights: { budget: 25 } } }).detail).toMatch(/Custom/);
  });

  it("messaging rules reflect the opt-out keywords actually used", () => {
    expect(messagingRulesCheck({ optOutKeywords: [] }).status).toBe("needs_attention");
    expect(messagingRulesCheck({ optOutKeywords: ["stop", "cancel"] })).toMatchObject({
      status: "ready",
      detail: "Opt-out keywords: stop, cancel",
    });
    // No stored keywords → the inbound pipeline uses its defaults.
    expect(messagingRulesCheck(null).status).toBe("ready");
    expect(messagingRulesCheck(undefined).status).toBe("needs_attention");
  });

  it("booking uses the workspace bookingUrl before DEFAULT_BOOKING_URL", () => {
    expect(bookingCheck({ agent: { bookingUrl: "https://cal.example/acme" }, defaultBookingUrlConfigured: false }))
      .toMatchObject({ status: "ready", detail: "Workspace booking link set" });
    expect(bookingCheck({ agent: { bookingUrl: null }, defaultBookingUrlConfigured: true }).status).toBe("ready");
    expect(bookingCheck({ agent: { bookingUrl: "  " }, defaultBookingUrlConfigured: false }).status).toBe(
      "optional",
    );
  });

  it("business profile needs more than the name created with the workspace", () => {
    expect(businessProfileCheck({ organisationName: "Acme", productCount: 0, audienceCount: 0 }).status).toBe(
      "needs_attention",
    );
    expect(businessProfileCheck({ organisationName: "Acme", productCount: null, audienceCount: null }).status).toBe(
      "needs_attention",
    );
    expect(businessProfileCheck({ organisationName: "", productCount: 1, audienceCount: 1 }).status).toBe(
      "needs_attention",
    );
    expect(businessProfileCheck({ organisationName: "Acme", productCount: 1, audienceCount: 0 }).status).toBe(
      "ready",
    );
  });
});
