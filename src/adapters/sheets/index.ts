import type { ReportExportInput, ReportExportResult, SheetsAdapter } from "./types";
import { mockSheetsExportLog } from "./types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { allowMockTransports } from "@/lib/runtime";

export const SHEETS_NOT_CONNECTED_MESSAGE =
  "Google Sheets isn't connected, so nothing was exported. Use Export CSV instead, or ask your administrator to connect Google Sheets.";

/**
 * Local development / tests only: records report exports in memory and writes nothing to Google.
 * The result is flagged `mock: true` with a plain message so the UI never shows it as a real export.
 */
export class MockSheetsAdapter implements SheetsAdapter {
  readonly name = "sheets-mock";

  async exportReport(input: ReportExportInput): Promise<ReportExportResult> {
    const destination = `mock-sheet://${input.organisationId}/${input.reportId}`;
    mockSheetsExportLog.push({ ...input, exportedAt: new Date().toISOString() });
    logger.info("Mock Sheets export recorded (development only — nothing sent to Google)", {
      reportId: input.reportId,
      destination,
    });
    return {
      ok: true,
      mock: true,
      provider: this.name,
      destination,
      message:
        "Test export only — Google Sheets isn't connected in this development workspace, so nothing was written to a spreadsheet.",
      raw: { stored: true },
    };
  }
}

/** Outside development/test: there is no Sheets connection, so say so instead of faking success. */
export class NotConnectedSheetsAdapter implements SheetsAdapter {
  readonly name = "google-sheets";

  async exportReport(): Promise<ReportExportResult> {
    return {
      ok: false,
      notConnected: true,
      provider: this.name,
      error: SHEETS_NOT_CONNECTED_MESSAGE,
    };
  }
}

function fallbackAdapter(): SheetsAdapter {
  return allowMockTransports() ? new MockSheetsAdapter() : new NotConnectedSheetsAdapter();
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
      logger.warn("Google Sheets credentials missing; export not sent");
      return fallbackAdapter().exportReport(input);
    }

    // Credential-gated placeholder: without a verified OAuth/service-account flow we do not
    // invent token exchange. Callers with credentials should replace this with the official
    // googleapis client; until then we fail closed with a clear error rather than fake success.
    return {
      ok: false,
      provider: this.name,
      error:
        "Google Sheets export isn't available in this version yet, so nothing was exported. Use Export CSV instead.",
    };
  }
}

/**
 * Real Google Sheets when configured; otherwise the labelled mock in development/test, and an
 * explicit "not connected" failure everywhere else (never a silent mock success in production).
 */
export function getSheetsAdapter(): SheetsAdapter {
  const env = getEnv();
  if (env.GOOGLE_SHEETS_CREDENTIALS_JSON && env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return new GoogleSheetsAdapter();
  }
  return fallbackAdapter();
}

export { MockSheetsAdapter as MockSheetsAdapterClass };
export { clearMockSheetsExportLog, mockSheetsExportLog } from "./types";
