import { describe, expect, it } from "vitest";
import {
  getIndustryTemplate,
  INDUSTRY_TEMPLATES,
} from "@/services/crm-v2";

describe("industry templates", () => {
  it("lists config-only templates without Instagram-only assumption", () => {
    expect(INDUSTRY_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const creator = getIndustryTemplate("creator");
    expect(creator.config.notes.toLowerCase()).toMatch(/not the only/);
    const generic = getIndustryTemplate("nope");
    expect(generic.key).toBe("generic");
  });

  it("keeps coaching free of forced IG setter framing", () => {
    const coaching = getIndustryTemplate("coaching");
    expect(coaching.config.primaryChannels).toContain("calendar");
    expect(coaching.config.notes.toLowerCase()).not.toMatch(/only instagram/);
  });
});
