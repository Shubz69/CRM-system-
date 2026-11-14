import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contactFindFirst: vi.fn(),
  contactUpdateMany: vi.fn(),
  suppressionCreate: vi.fn(),
  suppressionUpdateMany: vi.fn(),
  outboundDispatchUpdateMany: vi.fn(),
  $transaction: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    contact: { findFirst: mocks.contactFindFirst, updateMany: mocks.contactUpdateMany },
    contactSuppression: {
      create: mocks.suppressionCreate,
      updateMany: mocks.suppressionUpdateMany,
    },
    outboundDispatch: { updateMany: mocks.outboundDispatchUpdateMany },
    $transaction: mocks.$transaction,
  },
}));
vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));
vi.mock("@/services/domain-events/append", () => ({ appendDomainEvent: vi.fn(async () => ({})) }));
vi.mock("@/services/followups", () => ({ cancelFollowUpsOnOptOut: vi.fn(async () => 0) }));
vi.mock("@/services/compute-governor", () => ({ planCompute: vi.fn() }));

import {
  applyOptOut,
  clearOptOut,
  DEFAULT_OPT_OUT_KEYWORDS,
  detectOptOut,
  matchOptOutKeyword,
} from "@/services/opt-out";
import { classifyInboundL0 } from "@/services/messaging/understanding";

describe("strict opt-out detection", () => {
  it.each([
    "STOP",
    "stop",
    "Stop.",
    "stop!!!",
    "🛑 STOP",
    "Unsubscribe",
    "unsubscribe me please",
    "stop messaging me",
    "Please STOP messaging me",
    "please stop",
    "ok stop",
    "I would like to unsubscribe",
    "can you stop messaging me",
    "leave me alone",
    "Remove me from your list",
    "Don’t message me again",
    "opt out",
  ])("treats %j as an opt-out", (text) => {
    expect(detectOptOut(text)).toBe(true);
    expect(classifyInboundL0(text).optedOut).toBe(true);
  });

  it.each([
    "I can't stop thinking about it",
    "We run non-stop",
    "Is this a one-stop shop?",
    "Where is the nearest bus stop",
    "I'm stopping by later",
    "Can I stop by tomorrow?",
    "Stop by the shop at 3?",
    "Stop-loss orders are fine",
    "How much is it? Don't want to stop now",
    "I already unsubscribed from the old list, but want this",
    "Can you send the pricing details?",
  ])("does not treat %j as an opt-out", (text) => {
    expect(detectOptOut(text)).toBe(false);
    expect(classifyInboundL0(text).optedOut).toBe(false);
  });

  it("keeps multi-word org-configured keywords working", () => {
    const keywords = ["no more messages", "take me off"];
    expect(detectOptOut("No more messages please", keywords)).toBe(true);
    expect(detectOptOut("please take me off the list", keywords)).toBe(true);
    expect(detectOptOut("there are no more messages to send?", keywords)).toBe(false);
    // Org list without "stop" does not opt out on "stop".
    expect(detectOptOut("stop", keywords)).toBe(false);
  });

  it("reports the matched keyword", () => {
    expect(matchOptOutKeyword("Stop messaging me")).toBe("stop");
    expect(matchOptOutKeyword("stop messaging me", ["stop messaging"])).toBe("stop messaging");
    expect(classifyInboundL0("unsubscribe").matchedKeywords).toEqual(["unsubscribe"]);
    expect(DEFAULT_OPT_OUT_KEYWORDS).toContain("leave me alone");
  });
});

describe("applyOptOut / clearOptOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contactUpdateMany.mockResolvedValue({ count: 1 });
    mocks.suppressionCreate.mockResolvedValue({ id: "sup-1" });
    mocks.suppressionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboundDispatchUpdateMany.mockResolvedValue({ count: 0 });
    mocks.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)({
          contact: { findFirst: mocks.contactFindFirst, updateMany: mocks.contactUpdateMany },
          contactSuppression: { create: mocks.suppressionCreate },
        });
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
  });

  it("merges opt-out details into existing contact metadata instead of replacing it", async () => {
    mocks.contactFindFirst.mockResolvedValue({
      metadata: { DO_NOT_CONTACT: true, origin: "simulator" },
    });

    await applyOptOut({
      organisationId: "org-1",
      contactId: "contact-1",
      source: "inbound_keyword",
      reason: "STOP",
    });

    expect(mocks.contactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          optedOut: true,
          metadata: {
            DO_NOT_CONTACT: true,
            origin: "simulator",
            optOutSource: "inbound_keyword",
            optOutReason: "STOP",
          },
        }),
      }),
    );
  });

  it("clearOptOut expires the active OPT_OUT suppression so a human can reply again", async () => {
    await clearOptOut({ organisationId: "org-1", contactId: "contact-1", userId: "user-1" });

    expect(mocks.contactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "contact-1", organisationId: "org-1" },
        data: expect.objectContaining({ optedOut: false }),
      }),
    );
    expect(mocks.suppressionUpdateMany).toHaveBeenCalledTimes(1);
    const args = mocks.suppressionUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { expiresAt: Date };
    };
    expect(args.where).toMatchObject({
      organisationId: "org-1",
      contactId: "contact-1",
      reason: "OPT_OUT",
    });
    expect(args.data.expiresAt).toBeInstanceOf(Date);
    expect(args.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
