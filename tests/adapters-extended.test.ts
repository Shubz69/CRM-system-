import { describe, expect, it } from "vitest";
import { chunkText } from "@/services/knowledge";
import { MockBookingProvider, clearMockBookingLog, mockBookingLog } from "@/adapters/booking";
import { getSheetsAdapter, clearMockSheetsExportLog, mockSheetsExportLog } from "@/adapters/sheets";
import { getEmailAdapter, clearMockEmailLog, mockEmailLog } from "@/adapters/email";

describe("Knowledge chunking", () => {
  it("splits long content into fixed-size chunks", () => {
    const content = "a".repeat(2000);
    const chunks = chunkText(content, 800);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(800);
    expect(chunks[2]?.length).toBe(400);
  });

  it("returns empty for blank content", () => {
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("Booking adapter", () => {
  it("records mock booking links and parses event webhooks", async () => {
    clearMockBookingLog();
    const provider = new MockBookingProvider();
    const link = await provider.createBookingLink({
      organisationId: "org_1",
      contactId: "contact_1",
      conversationId: "conv_1",
    });
    expect(link.url).toContain("contact_1");
    expect(mockBookingLog).toHaveLength(1);

    const parsed = provider.parseWebhook({
      event: "created",
      externalId: "evt_1",
      contactExternalId: "sub_1",
      scheduledAt: "2026-08-06T15:00:00.000Z",
    });
    expect(parsed?.status).toBe("CREATED");
    expect(parsed?.externalId).toBe("evt_1");
  });
});

describe("Sheets and email adapters", () => {
  it("records mock sheet exports", async () => {
    clearMockSheetsExportLog();
    const result = await getSheetsAdapter().exportReport({
      organisationId: "org_1",
      reportId: "rep_1",
      title: "Daily",
      type: "daily",
      payload: { newConversations: 3 },
    });
    expect(result.ok).toBe(true);
    expect(mockSheetsExportLog).toHaveLength(1);
  });

  it("records mock emails", async () => {
    clearMockEmailLog();
    const result = await getEmailAdapter().send({
      organisationId: "org_1",
      to: ["ops@example.com"],
      subject: "Daily report",
      bodyText: "hello",
    });
    expect(result.ok).toBe(true);
    expect(mockEmailLog).toHaveLength(1);
  });
});
