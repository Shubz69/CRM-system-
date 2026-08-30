import { z } from "zod";

export const planStepSchema = z.object({
  agentName: z.string().min(1),
  input: z.record(z.unknown()),
});

export const agentPlanSchema = z.object({
  steps: z.array(planStepSchema).min(1).max(16),
  plainEnglishPlan: z.string().min(1).max(500),
});

export type PlanStep = z.infer<typeof planStepSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

export const clarificationSchema = z.object({
  kind: z.literal("clarification"),
  question: z.string().min(1).max(400),
  options: z.array(z.string().min(1).max(120)).min(2).max(4),
});

export type Clarification = z.infer<typeof clarificationSchema>;

export type PlanResult =
  | { kind: "plan"; plan: AgentPlan }
  | Clarification;

import type { AgentAnswerMode } from "@prisma/client";

export type OrgAgentContext = {
  organisationId: string;
  organisationName?: string;
  /** Remaining monthly allowance in cents, when known — for plain cost copy later. */
  remainingAllowanceCents?: number | null;
  /** Uploaded reference Asset id for imaging runs. */
  referenceAssetId?: string | null;
  /** Explicit or detected answer mode — skips format clarification when set. */
  answerMode?: AgentAnswerMode | null;
};
