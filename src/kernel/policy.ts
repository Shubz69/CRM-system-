import type {
  AutopilotCapabilityMode,
  PolicyContext,
  PolicyDecision,
  ToolDefinition,
  ToolRiskLevel,
} from "@/kernel/types";
import { getTool } from "@/kernel/tool-registry";

function modeForRisk(
  risk: ToolRiskLevel,
  autopilotModes?: Record<string, AutopilotCapabilityMode>,
): AutopilotCapabilityMode {
  // Map tool risk onto existing autopilot capability knobs where possible.
  if (risk === "outbound_message") {
    return autopilotModes?.followUps ?? "approval_required";
  }
  if (risk === "publish") {
    // No dedicated publish key yet — treat like follow-ups (human gate).
    return autopilotModes?.contentRecommendations ?? "approval_required";
  }
  if (risk === "write_internal") {
    return autopilotModes?.pipelineManagement ?? "automatic";
  }
  if (risk === "destructive" || risk === "admin") {
    return "disabled";
  }
  return "automatic";
}

/**
 * Decide whether a tool may run automatically, needs approval, or is denied.
 * Aligns with Autopilot defaults: outbound/publish require approval.
 */
export function evaluateToolPolicy(
  toolName: string,
  ctx: PolicyContext,
  override?: ToolDefinition,
): PolicyDecision {
  const tool = override ?? getTool(toolName);
  if (!tool) {
    return {
      effect: "deny",
      reason: `Unknown tool: ${toolName}`,
      risk: "admin",
      toolName,
    };
  }

  const mode = modeForRisk(tool.risk, ctx.autopilotModes);

  if (mode === "disabled") {
    return {
      effect: "deny",
      reason: `Tool ${toolName} is disabled by organisation policy (risk=${tool.risk}).`,
      risk: tool.risk,
      toolName,
    };
  }

  if (mode === "approval_required" || tool.risk === "outbound_message" || tool.risk === "publish") {
    return {
      effect: "require_approval",
      reason: `Tool ${toolName} requires human approval before execution.`,
      risk: tool.risk,
      toolName,
    };
  }

  if (tool.risk === "destructive" || tool.risk === "admin") {
    return {
      effect: "deny",
      reason: `Tool ${toolName} requires elevated confirmation and is not auto-runnable.`,
      risk: tool.risk,
      toolName,
    };
  }

  return {
    effect: "allow",
    reason: `Tool ${toolName} permitted for automatic use (risk=${tool.risk}).`,
    risk: tool.risk,
    toolName,
  };
}

export function defaultRiskPolicySummary(): Record<ToolRiskLevel, string> {
  return {
    read: "Automatic",
    write_internal: "Automatic (configurable)",
    outbound_message: "Approval required by default",
    publish: "Approval required by default",
    destructive: "Elevated confirmation / deny auto",
    admin: "Elevated confirmation / deny auto",
  };
}
