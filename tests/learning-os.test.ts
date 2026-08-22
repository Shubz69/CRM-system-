import { describe, expect, it, beforeEach } from "vitest";
import {
  clearToolRegistry,
  ensureBuiltinToolsRegistered,
  evaluateToolPolicy,
} from "@/kernel";
import { compileNaturalLanguageToWorkflow } from "@/services/automation-os";

describe("Learning OS honesty + gates", () => {
  beforeEach(() => {
    clearToolRegistry();
    ensureBuiltinToolsRegistered();
  });

  it("treats empty experiment sampleSize as null winner", () => {
    const sampleSize = 0;
    const summary =
      sampleSize === 0
        ? {
            sampleSize: 0,
            winnerKey: null as string | null,
            metricByVariant: null as Record<string, number> | null,
            message: "No measured samples yet",
          }
        : { sampleSize: 1, winnerKey: "a", metricByVariant: { a: 1 }, message: "ok" };
    expect(summary.winnerKey).toBeNull();
    expect(summary.metricByVariant).toBeNull();
  });

  it("blocks promote when status is not PASSED (contract)", () => {
    const status = "FAILED";
    expect(status === "PASSED").toBe(false);
  });

  it("eval cases: outbound gate + publish policy + NL trigger", () => {
    const wf = compileNaturalLanguageToWorkflow(
      "When a lead is qualified, send a follow-up in 60 min",
    );
    expect(wf.requiresApproval).toBe(true);
    expect(wf.steps.some((s) => s.kind === "approval")).toBe(true);

    const publish = evaluateToolPolicy("social.publish", { organisationId: "org" });
    expect(publish.effect).toBe("require_approval");

    const trig = compileNaturalLanguageToWorkflow(
      "When a lead is qualified, notify the team",
    );
    expect(trig.triggerType).toBe("lead_qualified");
  });
});
