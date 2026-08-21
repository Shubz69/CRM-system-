/**
 * Agent Desk AI Kernel — shared runtime primitives.
 * See docs/AGENT-KERNEL.md
 */

export type {
  ToolRiskLevel,
  ToolCostClass,
  ToolDefinition,
  PolicyContext,
  PolicyDecision,
  PolicyEffect,
  MissionDescriptor,
  MissionStatus,
  KernelModelCapability,
  AutopilotCapabilityMode,
} from "@/kernel/types";

export {
  registerTool,
  getTool,
  listTools,
  clearToolRegistry,
  ensureBuiltinToolsRegistered,
} from "@/kernel/tool-registry";

export { evaluateToolPolicy, defaultRiskPolicySummary } from "@/kernel/policy";
