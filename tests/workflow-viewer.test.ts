import { describe, expect, it } from "vitest";
import { compileNaturalLanguageToWorkflow } from "@/services/automation-os";

describe("workflow viewer data contract", () => {
  it("NL compile produces ordered steps with kinds for the visual viewer", () => {
    const wf = compileNaturalLanguageToWorkflow(
      "When a lead is qualified, notify the team and send a follow-up in 60 min",
    );
    expect(wf.steps.length).toBeGreaterThanOrEqual(3);
    expect(wf.steps[0]?.kind).toBe("trigger");
    expect(wf.steps.some((s) => s.kind === "action")).toBe(true);
    expect(wf.steps.some((s) => s.kind === "approval")).toBe(true);
    expect(wf.steps.every((s) => s.id && s.label)).toBe(true);
  });
});
