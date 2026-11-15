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

  it("preserves score, pricing topic, and review-only reply for the customer example", () => {
    const wf = compileNaturalLanguageToWorkflow(
      "When a lead scores above 60 and asks about pricing, notify me and draft a suggested reply for my review. Never send automatically.",
    );
    // Only triggers that are emitted / actions with an executor (no message_received-only
    // context, no draft_reply_for_review — it had no executor and silently did nothing).
    // A score condition needs a trigger that runs after the AI scored the message (the
    // new-message trigger fires before scoring, so the rule could never match there).
    expect(wf.triggerType).toBe("lead_score_changed");
    expect(wf.conditions.minScore).toBe(60);
    expect(wf.conditions.topicIncludes).toEqual(["pricing", "price"]);
    expect(wf.conditions.requireHumanReview).toBe(true);
    expect(wf.actions.some((a) => a.type === "notify_team")).toBe(true);
    expect(wf.actions.some((a) => a.type === "create_task")).toBe(true);
    expect(wf.actions.some((a) => a.type === "draft_reply_for_review")).toBe(false);
    expect(wf.actions.some((a) => a.type === "send_message")).toBe(false);
    expect(wf.requiresApproval).toBe(true);
    expect(wf.unsupportedNotes?.join(" ")).toMatch(/can't draft replies/i);
  });
});
