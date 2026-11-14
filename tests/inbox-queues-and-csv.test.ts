import { describe, expect, it } from "vitest";
import {
  conversationNeedsReply,
  matchesInboxQueue,
  newReplyIdempotencyKey,
  parseInboxQueue,
} from "@/app/(app)/inbox/inbox-queues";
import { csvCell, csvRow } from "@/lib/csv";

const base = {
  unreadCount: 0,
  aiPaused: false,
  needsHumanReview: false,
  lead: null,
  lastInboundAt: null as string | null,
  lastOutboundAt: null as string | null,
};

describe("inbox queues", () => {
  it("reads ?queue= from the URL and falls back to all", () => {
    expect(parseInboxQueue("human")).toBe("human");
    expect(parseInboxQueue("needs_reply")).toBe("needs_reply");
    expect(parseInboxQueue("bogus")).toBe("all");
    expect(parseInboxQueue(null)).toBe("all");
  });

  it("needs reply only when the customer's last message is newer than ours", () => {
    expect(conversationNeedsReply({ lastInboundAt: "2026-11-12T10:00:00Z", lastOutboundAt: null })).toBe(true);
    expect(
      conversationNeedsReply({ lastInboundAt: "2026-11-12T10:05:00Z", lastOutboundAt: "2026-11-12T10:00:00Z" }),
    ).toBe(true);
    expect(
      conversationNeedsReply({ lastInboundAt: "2026-11-12T10:00:00Z", lastOutboundAt: "2026-11-12T10:01:00Z" }),
    ).toBe(false);
    expect(conversationNeedsReply({ lastInboundAt: null, lastOutboundAt: "2026-11-12T10:01:00Z" })).toBe(false);
  });

  it("a conversation we already answered is not in Needs reply even with a preview", () => {
    const answered = {
      ...base,
      lastInboundAt: "2026-11-12T10:00:00Z",
      lastOutboundAt: "2026-11-12T10:02:00Z",
    };
    expect(matchesInboxQueue(answered, "needs_reply")).toBe(false);
    expect(matchesInboxQueue(answered, "all")).toBe(true);
  });

  it("keeps the other queue rules", () => {
    expect(matchesInboxQueue({ ...base, aiPaused: true }, "human")).toBe(true);
    expect(matchesInboxQueue({ ...base, lead: { score: 80 } }, "hot")).toBe(true);
    expect(matchesInboxQueue({ ...base, lead: { score: 10 } }, "hot")).toBe(false);
    expect(matchesInboxQueue({ ...base, unreadCount: 2 }, "waiting")).toBe(false);
    expect(matchesInboxQueue(base, "waiting")).toBe(true);
  });

  it("generates a fresh, valid-length reply key each time", () => {
    const a = newReplyIdempotencyKey();
    const b = newReplyIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(128);
  });
});

describe("pipeline CSV export (shared csvRow)", () => {
  it("neutralises spreadsheet formulas from contact names", () => {
    expect(csvCell('=HYPERLINK("http://evil.test","click")')).toBe(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(csvCell("+cmd")).toBe(`"'+cmd"`);
    expect(csvCell("-2+3")).toBe(`"'-2+3"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell("\rx")).toBe(`"'\rx"`);
  });

  it("leaves normal values alone", () => {
    expect(csvCell("Jane Doe")).toBe(`"Jane Doe"`);
    expect(csvCell("a=b")).toBe(`"a=b"`);
    expect(csvCell(-5)).toBe("-5");
  });

  it("builds a pipeline export row", () => {
    expect(csvRow(["=1+1", "@evil", "Qualified", 72, "QUALIFIED"])).toBe(
      `"'=1+1","'@evil","Qualified",72,"QUALIFIED"`,
    );
  });
});
