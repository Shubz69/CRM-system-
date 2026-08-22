import { describe, expect, it } from "vitest";
import { assertWhyEvidence } from "@/services/content-os";
import {
  clearToolRegistry,
  ensureBuiltinToolsRegistered,
  evaluateToolPolicy,
  getTool,
} from "@/kernel";

describe("assertWhyEvidence", () => {
  it("requires rationale and a link", () => {
    expect(() => assertWhyEvidence({ rationale: "" })).toThrow(/rationale/i);
    expect(() =>
      assertWhyEvidence({ rationale: "Because trends say so" }),
    ).toThrow(/link/i);
  });

  it("accepts research-backed evidence", () => {
    const why = assertWhyEvidence({
      rationale: "Findings from this week's research",
      researchJobId: "job_1",
      sourceUrls: ["https://example.com/a"],
    });
    expect(why.researchJobId).toBe("job_1");
    expect(why.sourceUrls).toHaveLength(1);
  });
});

describe("content + publish kernel tools", () => {
  it("registers content.propose and keeps publish gated", () => {
    clearToolRegistry();
    ensureBuiltinToolsRegistered();
    expect(getTool("content.propose")?.risk).toBe("write_internal");
    const publish = evaluateToolPolicy("social.publish", { organisationId: "org_1" });
    expect(publish.effect).toBe("require_approval");
  });
});
