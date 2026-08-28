import { describe, expect, it } from "vitest";
import {
  automationActionLabel,
  automationTriggerLabel,
  formatKpiValue,
  kpiLabel,
  publishStatusMessage,
  statusLabel,
  trendStageLabel,
} from "@/lib/customer-labels";
import { ADMIN_SUBNAV, ANALYTICS_SUBNAV, sectionForPath } from "@/lib/navigation";

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

  it("never exposes raw automation enum keys to customers", () => {
    expect(automationTriggerLabel("lead_created")).toBe("A new lead arrives");
    expect(automationTriggerLabel("lead_qualified")).toBe("A lead becomes qualified");
    expect(automationActionLabel("send_follow_up")).toBe("Send a follow-up message");
    expect(automationActionLabel("notify_team")).toBe("Notify the team");
    expect(automationTriggerLabel("lead_created")).not.toMatch(/_/);
    expect(automationActionLabel("send_follow_up")).not.toMatch(/_/);
  });
});

describe("role-aware learning surfaces", () => {
  it("keeps customer Learning under Analytics and eng lab under Admin", () => {
    expect(ANALYTICS_SUBNAV.some((i) => i.href === "/learning")).toBe(true);
    expect(ADMIN_SUBNAV.some((i) => i.href === "/admin/learning-lab")).toBe(true);
    expect(sectionForPath("/learning")?.id).toBe("analytics");
    expect(sectionForPath("/admin/learning-lab")?.id).toBe("admin");
  });
});
