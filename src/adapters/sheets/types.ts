export type ReportExportInput = {
  organisationId: string;
  reportId: string;
  title: string;
  type: string;
  payload: Record<string, unknown>;
  spreadsheetId?: string;
};

export type ReportExportResult = {
  ok: boolean;
  provider: string;
  destination?: string;
  error?: string;
  raw?: unknown;
};

export interface SheetsAdapter {
  readonly name: string;
  exportReport(input: ReportExportInput): Promise<ReportExportResult>;
}

export type MockSheetsRecord = ReportExportInput & { exportedAt: string };

export const mockSheetsExportLog: MockSheetsRecord[] = [];

export function clearMockSheetsExportLog(): void {
  mockSheetsExportLog.length = 0;
}
