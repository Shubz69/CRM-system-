import type { AgentAnswerMode } from "@prisma/client";
import type { ComputePlanInput, VerificationDepth } from "@/services/compute-governor/types";

/**
 * Map answer modes into existing Compute Governor controls.
 * Does not create separate pipelines.
 */
export function computeHintsForAnswerMode(
  answerMode: AgentAnswerMode,
  consequence?: ComputePlanInput["consequence"],
): Pick<
  ComputePlanInput,
  | "answerMode"
  | "verificationBudget"
  | "complexity"
  | "consequence"
  | "contextBudget"
  | "toolBudget"
  | "preferCache"
> {
  switch (answerMode) {
    case "QUICK":
      return {
        answerMode,
        verificationBudget: "FAST",
        complexity: "LOW",
        consequence: consequence ?? "LOW",
        contextBudget: 1_500,
        toolBudget: 3,
        preferCache: true,
      };
    case "EXECUTIVE":
      return {
        answerMode,
        verificationBudget: "STANDARD",
        complexity: "MEDIUM",
        consequence: consequence ?? "MEDIUM",
        contextBudget: 4_000,
        toolBudget: 6,
        preferCache: false,
      };
    case "ACTION": {
      const highConsequence =
        consequence === "HIGH" ||
        consequence === "CRITICAL" ||
        (typeof consequence === "number" && consequence >= 2);
      return {
        answerMode,
        verificationBudget: "STANDARD",
        complexity: highConsequence ? "HIGH" : "MEDIUM",
        consequence: consequence ?? "MEDIUM",
        contextBudget: 4_000,
        toolBudget: highConsequence ? 10 : 6,
        preferCache: false,
      };
    }
    case "DEEP":
      return {
        answerMode,
        verificationBudget: "DEEP",
        complexity: "CRITICAL",
        consequence: consequence ?? "HIGH",
        contextBudget: 8_000,
        toolBudget: 14,
        preferCache: false,
      };
    default:
      return {
        answerMode,
        verificationBudget: "STANDARD" satisfies VerificationDepth,
        complexity: "MEDIUM",
        contextBudget: 4_000,
        toolBudget: 8,
        preferCache: false,
      };
  }
}
