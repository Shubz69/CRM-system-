import { describe, expect, it } from "vitest";
import { HOME_OUTCOME_CARDS, PRIMARY_NAV, SECONDARY_NAV, WORKSPACE_NAV } from "@/lib/navigation";

describe("frontend navigation simplification", () => {
  it("keeps daily work in primary nav", () => {
    expect(PRIMARY_NAV.map((i) => i.href)).toEqual(["/ask", "/inbox", "/pipeline", "/contacts"]);
    expect(PRIMARY_NAV[0]?.label).toBe("Home");
  });

  it("keeps power-user routes in secondary nav (not deleted)", () => {
    const hrefs = SECONDARY_NAV.map((i) => i.href);
    for (const required of ["/dashboard", "/attention", "/simulator"]) {
      expect(hrefs).toContain(required);
    }
  });

  it("still exposes inbox, knowledge, and reports somewhere in the workspace nav", () => {
    const hrefs = WORKSPACE_NAV.map((i) => i.href);
    for (const required of ["/inbox", "/knowledge", "/insights", "/reports", "/integrations"]) {
      expect(hrefs).toContain(required);
    }
  });

  it("exposes six outcome cards for the home surface", () => {
    expect(HOME_OUTCOME_CARDS).toHaveLength(6);
    expect(HOME_OUTCOME_CARDS.map((c) => c.title)).toEqual([
      "Handle my DMs",
      "Research a topic",
      "What's trending",
      "Make an image",
      "Write content",
      "Show me reports",
    ]);
  });
});
