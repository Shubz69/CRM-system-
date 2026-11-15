/**
 * Sheets export with nothing configured used to report "Exported via sheets-mock" in every
 * environment. Outside development/test it now fails with a clear "not connected" result; the
 * development mock is flagged so the UI never shows it as a real export.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock("@/lib/env", () => ({ getEnv: () => env.value }));

import {
  clearMockSheetsExportLog,
  getSheetsAdapter,
  mockSheetsExportLog,
  SHEETS_NOT_CONNECTED_MESSAGE,
} from "@/adapters/sheets";

const input = {
  organisationId: "org_1",
  reportId: "rep_1",
  title: "Daily",
  type: "daily",
  payload: { newConversations: 3 },
};

const originalMode = process.env.APP_RUNTIME_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.APP_RUNTIME_MODE;
  else process.env.APP_RUNTIME_MODE = originalMode;
  env.value = {};
  clearMockSheetsExportLog();
});

describe("Google Sheets export", () => {
  it("in production with nothing configured: no fake success, a clear not-connected error", async () => {
    process.env.APP_RUNTIME_MODE = "production";
    const result = await getSheetsAdapter().exportReport(input);
    expect(result.ok).toBe(false);
    expect(result.notConnected).toBe(true);
    expect(result.error).toBe(SHEETS_NOT_CONNECTED_MESSAGE);
    expect(result.error).toMatch(/Google Sheets isn't connected/);
    expect(result.provider).not.toMatch(/mock/);
    expect(mockSheetsExportLog).toHaveLength(0);
  });

  it("in development the stand-in export is clearly labelled as a test, not an export", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    const result = await getSheetsAdapter().exportReport(input);
    expect(result.ok).toBe(true);
    expect(result.mock).toBe(true);
    expect(result.message).toMatch(/Test export only/);
    expect(mockSheetsExportLog).toHaveLength(1);
  });

  it("with credentials present the live adapter still fails closed (never a mock)", async () => {
    process.env.APP_RUNTIME_MODE = "production";
    env.value = { GOOGLE_SHEETS_CREDENTIALS_JSON: "{}", GOOGLE_SHEETS_SPREADSHEET_ID: "sheet" };
    const result = await getSheetsAdapter().exportReport(input);
    expect(result.ok).toBe(false);
    expect(result.mock).toBeUndefined();
    expect(mockSheetsExportLog).toHaveLength(0);
  });
});
