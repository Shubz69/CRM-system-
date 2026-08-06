import type { ReportExportInput, ReportExportResult, SheetsAdapter } from "./types";
import { mockSheetsExportLog } from "./types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Records report exports in memory. Used when Google Sheets credentials are absent.
 */
export class MockSheetsAdapter implements SheetsAdapter {
  readonly name = "sheets-mock";

  async exportReport(input: ReportExportInput): Promise<ReportExportResult> {
    const destination = `mock-sheet://${input.organisationId}/${input.reportId}`;
    mockSheetsExportLog.push({ ...input, exportedAt: new Date().toISOString() });
    logger.info("Mock Sheets export recorded", {
      reportId: input.reportId,
      destination,
    });
    return { ok: true, provider: this.name, destination, raw: { stored: true } };
  }
}

/**
 * Live Google Sheets export skeleton.
 * Requires GOOGLE_SHEETS_CREDENTIALS_JSON + GOOGLE_SHEETS_SPREADSHEET_ID.
 * Does not invent Sheets API shapes beyond a documented values.append-style call.
 */
export class GoogleSheetsAdapter implements SheetsAdapter {
  readonly name = "google-sheets";

  async exportReport(input: ReportExportInput): Promise<ReportExportResult> {
    const env = getEnv();
    if (!env.GOOGLE_SHEETS_CREDENTIALS_JSON || !env.GOOGLE_SHEETS_SPREADSHEET_ID) {
      logger.warn("Google Sheets credentials missing; falling back to mock export");
      return new MockSheetsAdapter().exportReport(input);
    }

    // Credential-gated placeholder: without a verified OAuth/service-account flow we do not
    // invent token exchange. Callers with credentials should replace this with the official
    // googleapis client; until then we fail closed with a clear error rather than fake success.
    return {
      ok: false,
      provider: this.name,
      error:
        "Live Google Sheets export requires the official googleapis client wiring. Credentials are present but the live transport is not enabled in this build — use mock export or wire googleapis.",
    };
  }
}

export function getSheetsAdapter(): SheetsAdapter {
  const env = getEnv();
  if (env.GOOGLE_SHEETS_CREDENTIALS_JSON && env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return new GoogleSheetsAdapter();
  }
  return new MockSheetsAdapter();
}

export { MockSheetsAdapter as MockSheetsAdapterClass };
export { clearMockSheetsExportLog, mockSheetsExportLog } from "./types";
