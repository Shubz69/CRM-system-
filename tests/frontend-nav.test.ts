import { describe, expect, it } from "vitest";
import { HOME_OUTCOME_CARDS, PRIMARY_NAV, SECONDARY_NAV } from "@/lib/navigation";

describe("frontend navigation simplification", () => {
  it("keeps Home as the only primary nav item", () => {
    expect(PRIMARY_NAV.map((i) => i.href)).toEqual(["/ask"]);
    expect(PRIMARY_NAV[0]?.label).toBe("Home");
  });

  it("keeps power-user routes in secondary nav (not deleted)", () => {
    const hrefs = SECONDARY_NAV.map((i) => i.href);
    for (const required of [
      "/inbox",
      "/pipeline",
      "/knowledge",
      "/insights",
      "/reports",
      "/integrations",
      "/dashboard",
    ]) {
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
