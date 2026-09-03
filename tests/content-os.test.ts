import { describe, expect, it } from "vitest";
import { assertWhyEvidence } from "@/services/content-os";
import {
  clearToolRegistry,
  ensureBuiltinToolsRegistered,
  evaluateToolPolicy,
  getTool,
} from "@/kernel";

describe("assertWhyEvidence", () => {
  it("requires rationale and a link unless operator draft", () => {
    expect(() => assertWhyEvidence({ rationale: "" })).toThrow(/rationale/i);
    expect(() =>
      assertWhyEvidence({ rationale: "Because trends say so" }),
    ).toThrow(/source URL|manual draft/i);
  });

  it("accepts operator-created drafts without an external URL", () => {
    const why = assertWhyEvidence({
      rationale: "Manual draft created in Content OS",
      operatorDraft: true,
    });
    expect(why.operatorDraft).toBe(true);
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
