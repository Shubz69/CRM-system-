import { z } from "zod";

/** Practical mode schemas — optional fields stay optional; no forced empties. */

export const quickAnswerSchema = z.object({
  mode: z.literal("quick"),
  answer: z.string().min(1),
  researchJobId: z.string().optional(),
});

export const executiveAnswerSchema = z.object({
  mode: z.literal("executive"),
  keyFinding: z.string().min(1),
  whatMatters: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
  recommendation: z.string().min(1).optional(),
  researchJobId: z.string().optional(),
});

export const actionItemSchema = z.object({
  what: z.string().min(1),
  why: z.string().min(1).optional(),
  order: z.number().int().positive().optional(),
  dependencies: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  agentDeskCapability: z
    .enum([
      "create_opportunity",
      "create_task",
      "create_mission",
      "draft_content",
      "prepare_outreach",
      "save_research",
      "update_business_state",
    ])
    .optional(),
  /** Pending ApprovalRequest id — never auto-executed. */
  approvalRequestId: z.string().optional(),
});

export const actionAnswerSchema = z.object({
  mode: z.literal("action"),
  actions: z.array(actionItemSchema).min(1),
  researchJobId: z.string().optional(),
  summary: z.string().optional(),
});

export const deepAnswerSchema = z.object({
  mode: z.literal("deep"),
  executiveSummary: z.string().min(1),
  method: z.string().optional(),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1),
        sourceUrl: z.string().optional(),
        evidenceExcerpt: z.string().optional(),
        claimKind: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  evidence: z.array(z.string().min(1)).optional(),
  sources: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        platform: z.string().optional(),
      }),
    )
    .optional(),
  contradictions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  caveats: z.array(z.string()).optional(),
  businessImplications: z.string().optional(),
  marketImplications: z.string().optional(),
  recommendations: z.array(z.string()).optional(),
  nextActions: z.array(z.string()).optional(),
  researchJobId: z.string().optional(),
  /** Capability proposals awaiting approval — never auto-executed. */
  capabilityProposals: z
    .array(
      z.object({
        capability: z.string(),
        label: z.string(),
        approvalRequestId: z.string().optional(),
      }),
    )
    .optional(),
});

export const answerModeOutputSchema = z.discriminatedUnion("mode", [
  quickAnswerSchema,
  executiveAnswerSchema,
  actionAnswerSchema,
  deepAnswerSchema,
]);

export type QuickAnswer = z.infer<typeof quickAnswerSchema>;
export type ExecutiveAnswer = z.infer<typeof executiveAnswerSchema>;
export type ActionAnswer = z.infer<typeof actionAnswerSchema>;
export type DeepAnswer = z.infer<typeof deepAnswerSchema>;
export type AnswerModeOutput = z.infer<typeof answerModeOutputSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;
