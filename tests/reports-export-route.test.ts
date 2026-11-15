/**
 * Report export: "Google Sheets isn't connected" is a setup state, so it comes back as a plain
 * 409 with the adapter's message — not a 502 server error — and bad input gets a readable
 * sentence instead of zod's JSON.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportFindFirst: vi.fn(),
  exportReport: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: mocks.reportFindFirst },
    organisationMember: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({
    userId: "user_1",
    organisationId: "org_1",
    email: "owner@example.test",
  })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/adapters/sheets", () => ({
  getSheetsAdapter: () => ({ exportReport: mocks.exportReport }),
}));
vi.mock("@/adapters/email", () => ({ getEmailAdapter: () => ({ send: vi.fn() }) }));
vi.mock("@/services/audit", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { POST } from "@/app/api/reports/export/route";

function exportRequest(body: unknown) {
  return POST(
    new Request("http://localhost/api/reports/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/reports/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportFindFirst.mockResolvedValue({
      id: "rep_1",
      title: "Weekly",
      type: "weekly",
      payload: { newConversations: 4 },
    });
  });

  it("answers 'not connected' with a 409 and the adapter's message", async () => {
    mocks.exportReport.mockResolvedValueOnce({
      ok: false,
      notConnected: true,
      provider: "google-sheets",
      error: "Google Sheets isn't connected, so nothing was exported.",
    });

    const res = await exportRequest({ reportId: "rep_1", destination: "sheets" });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/isn't connected/);
  });

  it("still treats a real Sheets failure as a 502", async () => {
    mocks.exportReport.mockResolvedValueOnce({ ok: false, provider: "google-sheets", error: "Quota exceeded" });

    const res = await exportRequest({ reportId: "rep_1", destination: "sheets" });

    expect(res.status).toBe(502);
  });

  it("explains a bad destination in a sentence, not zod JSON", async () => {
    const res = await exportRequest({ reportId: "rep_1", destination: "fax" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Choose a report and where to export it (Sheets, email or CSV).");
  });
});
