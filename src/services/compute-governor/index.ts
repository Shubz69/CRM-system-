import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getAiRouterConfig,
  selectModelForTask,
} from "@/services/ai-router";
import {
  getAiProviderDefaults,
  resolveModelForTier,
  type AiModelTier,
} from "@/lib/ai-models";
import {
  assertWithinSpendCap,
  SpendCapExceededError,
} from "@/services/ai-spend-gate";
import { getOrganisationPreferences } from "@/services/agent-memory";
import { isIntelligenceFlagEnabled } from "@/services/intelligence-flags";
import type {
  ComputeBand,
  ComputeExecutionMode,
  ComputePlan,
  ComputePlanInput,
} from "./types";

export type { ComputePlan, ComputePlanInput } from "./types";

const MODE_TIER: Partial<Record<ComputeExecutionMode, AiModelTier>> = {
  ECONOMY: "economy",
  STANDARD: "default",
  ADVANCED: "advanced",
  DEEP: "advanced",
};

function bandScore(value: ComputeBand | number | undefined): number {
  if (typeof value === "number") return Math.max(0, Math.min(3, Math.round(value)));
  return value ? { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }[value] : 1;
}

function preferenceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "enabled" in value) {
    return typeof (value as { enabled?: unknown }).enabled === "boolean"
      ? (value as { enabled: boolean }).enabled
      : undefined;
  }
  return undefined;
}

function governorMode(input: ComputePlanInput): {
  mode: ComputeExecutionMode;
  reasons: string[];
} {
  const evidence = input.evidenceState ?? {};
  if (evidence.hasCache) return { mode: "CACHE", reasons: ["L0_CACHE_HIT"] };
  if (evidence.hasVerifiedClaim)
    return { mode: "DETERMINISTIC", reasons: ["L0_VERIFIED_CLAIM"] };
  if (evidence.hasBusinessState)
    return { mode: "DETERMINISTIC", reasons: ["L0_BUSINESS_STATE"] };
  if (evidence.hasDecisionMemory)
    return { mode: "DETERMINISTIC", reasons: ["L0_DECISION_MEMORY"] };
  if (evidence.deterministicCapable)
    return { mode: "DETERMINISTIC", reasons: ["L0_DETERMINISTIC_CAPABLE"] };

  // Answer-mode mapping into existing modes (single pipeline).
  if (input.answerMode === "QUICK") {
    return {
      mode: input.preferCache !== false ? "ECONOMY" : "ECONOMY",
      reasons: ["ANSWER_MODE_QUICK", "FAST", "CACHE_FIRST"],
    };
  }
  if (input.answerMode === "EXECUTIVE") {
    return { mode: "STANDARD", reasons: ["ANSWER_MODE_EXECUTIVE"] };
  }
  if (input.answerMode === "ACTION") {
    const consequence = bandScore(input.consequence);
    const mode: ComputeExecutionMode = consequence >= 2 ? "ADVANCED" : "STANDARD";
    return {
      mode,
      reasons: ["ANSWER_MODE_ACTION", `CONSEQUENCE_${consequence}`],
    };
  }
  if (input.answerMode === "DEEP") {
    return { mode: "DEEP", reasons: ["ANSWER_MODE_DEEP"] };
  }

  const score = Math.max(bandScore(input.complexity), bandScore(input.consequence));
  const mode: ComputeExecutionMode =
    score === 0 ? "ECONOMY" : score === 1 ? "STANDARD" : score === 2 ? "ADVANCED" : "DEEP";
  return {
    mode,
    reasons: [
      `COMPLEXITY_${bandScore(input.complexity)}`,
      `CONSEQUENCE_${bandScore(input.consequence)}`,
    ],
  };
}

function isSampledL0(organisationId: string, taskType: string, now = new Date()): boolean {
  const minute = now.toISOString().slice(0, 16);
  const digest = createHash("sha256")
    .update(`${organisationId}:${taskType}:${minute}`)
    .digest();
  return digest.readUInt32BE(0) % 100 === 0;
}

async function aggregateL0(input: ComputePlanInput, mode: ComputeExecutionMode): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCMinutes(0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);
  await prisma.computeAggregate.upsert({
    where: {
      organisationId_windowStart_mode_taskType: {
        organisationId: input.organisationId,
        windowStart,
        mode,
        taskType: input.taskType,
      },
    },
    create: {
      organisationId: input.organisationId,
      windowStart,
      windowEnd,
      mode,
      taskType: input.taskType,
      count: 1,
    },
    update: { count: { increment: 1 }, windowEnd },
  });
}

async function recordDecision(
  input: ComputePlanInput,
  plan: ComputePlan,
  errorSummary?: string,
): Promise<void> {
  const isL0 = plan.governorMode === "DETERMINISTIC" || plan.governorMode === "CACHE";
  const shouldRecord =
    !isL0 ||
    Boolean(input.escalationReason) ||
    Boolean(errorSummary) ||
    Boolean(input.cacheMiss) ||
    Boolean(input.importantCacheHit) ||
    isSampledL0(input.organisationId, input.taskType);
  if (!shouldRecord) return;

  await prisma.computeDecision.create({
    data: {
      organisationId: input.organisationId,
      taskType: input.taskType,
      executionMode: plan.governorMode,
      selectedModel: plan.selectedModel,
      selectedProvider: plan.selectedProvider,
      reasonCodes: plan.reasonCodes,
      escalationReason: plan.escalationReason,
      estimatedCostCents: plan.estimatedCostCents,
      qualityBudget: plan.qualityBudget,
      cacheHit: plan.governorMode === "CACHE",
      shadowLegacyTier: plan.legacySelection.tier,
      shadowLegacyModel: plan.legacySelection.model,
      shadowMatch: plan.selectedModel === plan.legacySelection.model,
      errorSummary,
      metadata: {
        activeMode: plan.activeMode,
        governorMode: plan.governorMode,
        shadowOnly: plan.shadowOnly,
        maturity: plan.maturity,
      } as Prisma.InputJsonValue,
    },
  });
}

export async function resolveActiveComputePlan(
  plan: ComputePlan,
): Promise<Pick<ComputePlan, "activeMode" | "selectedModel" | "selectedProvider">> {
  if (plan.shadowOnly) {
    return {
      activeMode: plan.activeMode,
      selectedModel: plan.legacySelection.model,
      selectedProvider: plan.legacySelection.provider,
    };
  }
  return {
    activeMode: plan.governorMode,
    selectedModel: plan.selectedModel,
    selectedProvider: plan.selectedProvider,
  };
}

/**
 * Phase 20A maturity: WORKING. Governor decisions are shadow-only by default.
 */
export async function planCompute(input: ComputePlanInput): Promise<ComputePlan> {
  const [router, enabled, preferences] = await Promise.all([
    getAiRouterConfig(),
    isIntelligenceFlagEnabled(input.organisationId, "computeGovernorEnabled"),
    getOrganisationPreferences({ organisationId: input.organisationId }),
  ]);
  const legacy = selectModelForTask({
    taskType: input.taskType,
    router,
    escalate: Boolean(input.escalationReason),
    leadScore: input.leadScore,
    confidence: input.confidence,
    modelOverride: input.modelOverride,
  });
  const provider = input.provider ?? getAiProviderDefaults().provider;
  const proposed = governorMode(input);
  const tier = MODE_TIER[proposed.mode];
  const governorModel = tier ? resolveModelForTier(tier) : undefined;
  const preferenceShadow = preferenceBoolean(preferences.computeGovernorShadowOnly);
  const envShadow = process.env.COMPUTE_GOVERNOR_SHADOW_ONLY !== "false";
  const shadowOnly = !enabled || (typeof preferenceShadow === "boolean" ? preferenceShadow : envShadow);
  const activeMode = shadowOnly
    ? ({ economy: "ECONOMY", default: "STANDARD", advanced: "ADVANCED" } as const)[legacy.tier]
    : proposed.mode;
  const estimatedCostCents =
    input.estimatedCostCents ??
    ({ ECONOMY: 1, STANDARD: 3, ADVANCED: 10, DEEP: 25 } as Partial<
      Record<ComputeExecutionMode, number>
    >)[proposed.mode];

  const defaultVerification =
    input.answerMode === "QUICK"
      ? "FAST"
      : input.answerMode === "DEEP"
        ? "DEEP"
        : "STANDARD";
  const verification = input.verificationBudget ?? defaultVerification;

  const plan: ComputePlan = {
    executionMode: activeMode,
    governorMode: proposed.mode,
    activeMode,
    reasonCodes: proposed.reasons,
    selectedModel: governorModel,
    selectedProvider: provider,
    qualityBudget: verification,
    verificationDepth: verification,
    estimatedCostCents,
    escalationReason: input.escalationReason,
    contextBudget: Math.max(256, input.contextBudget ?? 4_000),
    toolBudget: Math.max(0, input.toolBudget ?? 8),
    shadowOnly,
    maturity: "WORKING",
    legacySelection: { ...legacy, provider },
  };

  if (proposed.mode === "DETERMINISTIC" || proposed.mode === "CACHE") {
    await aggregateL0(input, proposed.mode);
  } else {
    try {
      await assertWithinSpendCap(input.organisationId, estimatedCostCents);
    } catch (error) {
      if (error instanceof SpendCapExceededError) {
        plan.reasonCodes.push("SPEND_CAP_DENIED");
        await recordDecision(input, plan, error.message);
      }
      throw error;
    }
  }

  await recordDecision(input, plan);
  return plan;
}
