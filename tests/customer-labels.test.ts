import { describe, expect, it } from "vitest";
import {
  formatKpiValue,
  kpiLabel,
  publishStatusMessage,
  statusLabel,
  trendStageLabel,
} from "@/lib/customer-labels";

describe("customer-labels", () => {
  it("maps KPI keys and currency units for customers", () => {
    expect(kpiLabel("open_pipeline_cents")).toBe("Open pipeline value");
    expect(formatKpiValue(125000, "GBP_CENTS")).toMatch(/£1[,.]?250/);
  });

  it("humanises status and publish reconciliation", () => {
    expect(statusLabel("RECONCILIATION_REQUIRED")).toBe("Needs confirmation");
    expect(statusLabel("WAITING_APPROVAL")).toBe("Needs approval");
    expect(publishStatusMessage("RECONCILIATION_REQUIRED")).toMatch(/couldn't confirm/i);
  });

  it("maps trend stages to plain language", () => {
    expect(trendStageLabel("GROWING")).toBe("Growing quickly");
    expect(trendStageLabel("SATURATED")).toBe("Saturated");
  });
});
