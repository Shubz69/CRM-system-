import type { MemberRole } from "@prisma/client";

/** Risk classification for tools / actions. */
export type ToolRiskLevel =
  | "read"
  | "write_internal"
  | "outbound_message"
  | "publish"
  | "destructive"
  | "admin";

export type ToolCostClass = "free" | "cheap" | "metered" | "expensive";

export type PolicyEffect = "allow" | "require_approval" | "deny";

export type AutopilotCapabilityMode = "automatic" | "approval_required" | "disabled";

/**
 * Declarative tool metadata. Implementations live in adapters;
 * the kernel only discovers and authorises.
 */
export type ToolDefinition = {
  name: string;
  version: string;
  description: string;
  risk: ToolRiskLevel;
  costClass: ToolCostClass;
  /** Permission string from src/lib/permissions when applicable. */
  requiredPermission?: string;
  /** Env / integration credential hint for UI. */
  requiredCredential?: string;
  timeoutMs?: number;
  /** Platforms this tool can touch (informational). */
  platforms?: string[];
};

export type PolicyContext = {
  organisationId: string;
  userId?: string | null;
  role?: MemberRole;
  isPlatformAdmin?: boolean;
  /** From Organisation.autopilotConfig capability keys. */
  autopilotModes?: Record<string, AutopilotCapabilityMode>;
};

export type PolicyDecision = {
  effect: PolicyEffect;
  reason: string;
  risk: ToolRiskLevel;
  toolName: string;
};

export type MissionStatus =
  | "DRAFT"
  | "PLANNED"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

/**
 * Logical mission — may map 1:1 to AgentRun today or parent multiple runs later.
 */
export type MissionDescriptor = {
  id?: string;
  organisationId: string;
  objective: string;
  status?: MissionStatus;
  agentRunId?: string;
};

export type KernelModelCapability =
  | "fast_classify"
  | "cheap_extract"
  | "long_reason"
  | "structured"
  | "vision"
  | "write"
  | "embed"
  | "image_generate";
