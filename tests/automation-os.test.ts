import { describe, expect, it } from "vitest";
import {
  compileNaturalLanguageToWorkflow,
  isOutboundAction,
} from "@/services/automation-os";

describe("NL → visible workflow", () => {
  it("compiles qualification + follow-up into gated steps", () => {
    const wf = compileNaturalLanguageToWorkflow(
      "When a lead is qualified, notify the team and send a follow-up in 60 min",
    );
    expect(wf.triggerType).toBe("lead_qualified");
    expect(wf.actions.some((a) => a.type === "notify_team")).toBe(true);
    expect(wf.actions.some((a) => a.type === "send_follow_up")).toBe(true);
    expect(wf.requiresApproval).toBe(true);
    expect(wf.steps.some((s) => s.kind === "approval")).toBe(true);
    expect(wf.steps[0]?.kind).toBe("trigger");
  });

  it("marks outbound actions", () => {
    expect(isOutboundAction("send_follow_up")).toBe(true);
    expect(isOutboundAction("notify_team")).toBe(false);
  });
});
