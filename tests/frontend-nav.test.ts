import { describe, expect, it } from "vitest";
import {
  ASK_OUTCOME_CARDS,
  CORE_NAV,
  CRM_SUBNAV,
  GROWTH_SUBNAV,
  HOME_OUTCOME_CARDS,
  POWER_TOOLS_NAV,
  PRIMARY_NAV,
  SETUP_NAV,
  WORKSPACE_NAV,
  sectionForPath,
} from "@/lib/navigation";

describe("frontend navigation IA redesign", () => {
  it("keeps a short core sidebar for daily work", () => {
    expect(CORE_NAV.map((i) => i.href)).toEqual([
      "/home",
      "/inbox",
      "/crm",
      "/growth",
      "/automations",
      "/analytics",
    ]);
    expect(PRIMARY_NAV[0]?.label).toBe("Home");
    expect(PRIMARY_NAV[0]?.href).toBe("/home");
  });

  it("groups CRM and Growth under section subnavs", () => {
    expect(CRM_SUBNAV.map((i) => i.href)).toEqual(
      expect.arrayContaining(["/contacts", "/companies", "/deals", "/pipeline"]),
    );
    expect(GROWTH_SUBNAV.map((i) => i.href)).toEqual(
      expect.arrayContaining(["/opportunities", "/knowledge", "/goals"]),
    );
    expect(sectionForPath("/contacts")?.id).toBe("crm");
    expect(sectionForPath("/goals")?.id).toBe("growth");
    expect(sectionForPath("/reports")?.id).toBe("analytics");
  });

  it("keeps setup short and power tools off the primary sidebar", () => {
    expect(SETUP_NAV.map((i) => i.href)).toEqual(["/integrations", "/settings"]);
    const power = POWER_TOOLS_NAV.map((i) => i.href);
    for (const required of ["/ask", "/attention", "/simulator", "/dashboard"]) {
      expect(power).toContain(required);
    }
  });

  it("still exposes inbox, knowledge, and reports somewhere in the workspace nav", () => {
    const hrefs = WORKSPACE_NAV.map((i) => i.href);
    for (const required of ["/inbox", "/knowledge", "/insights", "/reports", "/integrations"]) {
      expect(hrefs).toContain(required);
    }
  });

  it("keeps Admin off CORE and SETUP for platform-only gating", () => {
    expect(CORE_NAV.some((i) => i.href === "/admin")).toBe(false);
    expect(SETUP_NAV.some((i) => i.href === "/admin")).toBe(false);
    expect(sectionForPath("/admin/ai-ops")?.id).toBe("admin");
  });

  it("exposes outcome-grouped Ask cards", () => {
    expect(ASK_OUTCOME_CARDS.length).toBeGreaterThanOrEqual(6);
    expect(HOME_OUTCOME_CARDS).toBe(ASK_OUTCOME_CARDS);
    const titles = ASK_OUTCOME_CARDS.map((c) => c.title);
    expect(titles).toContain("Research a topic");
    expect(titles).toContain("What needs my attention?");
    expect(ASK_OUTCOME_CARDS.some((c) => c.group === "Sales")).toBe(true);
    expect(ASK_OUTCOME_CARDS.some((c) => c.group === "Messaging")).toBe(true);
  });
});
