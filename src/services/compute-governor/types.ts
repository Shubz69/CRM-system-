import type { AgentAnswerMode } from "@prisma/client";
import type { AiModelTier, AiTaskType } from "@/lib/ai-models";

export type ComputeExecutionMode =
  | "DETERMINISTIC"
  | "CACHE"
  | "ECONOMY"
  | "STANDARD"
  | "ADVANCED"
  | "DEEP";

export type VerificationDepth = "FAST" | "STANDARD" | "DEEP" | "MISSION_CRITICAL";
export type ComputeBand = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ComputePlanInput = {
  organisationId: string;
  taskType: AiTaskType;
  complexity?: ComputeBand | number;
  consequence?: ComputeBand | number;
  verificationBudget?: VerificationDepth;
  /** Ask/research answer mode — maps into existing governor controls (not a new pipeline). */
  answerMode?: AgentAnswerMode | null;
  /** Prefer CACHE/ECONOMY paths when evidence allows (QUICK mode). */
  preferCache?: boolean;
  evidenceState?: {
    hasVerifiedClaim?: boolean;
    hasBusinessState?: boolean;
    hasCache?: boolean;
    hasDecisionMemory?: boolean;
    deterministicCapable?: boolean;
  };
  cacheMiss?: boolean;
  importantCacheHit?: boolean;
  escalationReason?: string;
  estimatedCostCents?: number;
  contextBudget?: number;
  toolBudget?: number;
  modelOverride?: string;
  provider?: string;
  leadScore?: number;
  confidence?: number;
};

export type ComputePlan = {
  executionMode: ComputeExecutionMode;
  governorMode: ComputeExecutionMode;
  activeMode: ComputeExecutionMode;
  reasonCodes: string[];
  selectedModel?: string;
  selectedProvider?: string;
  qualityBudget: VerificationDepth;
  verificationDepth: VerificationDepth;
  estimatedCostCents?: number;
  escalationReason?: string;
  contextBudget: number;
  toolBudget: number;
  shadowOnly: boolean;
  maturity: "WORKING";
  legacySelection: {
    tier: AiModelTier;
    model: string;
    provider: string;
    reason: string;
  };
};
