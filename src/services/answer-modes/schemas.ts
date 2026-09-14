import { z } from "zod";

/** Practical mode schemas — optional fields stay optional; no forced empties. */

export const askTypedSectionSchema = z.object({
  type: z.enum(["strategy", "scripts", "posting_plan", "monetization"]),
  title: z.string().min(1),
  body: z.string().min(1),
  bullets: z.array(z.string().min(1)).optional(),
});

export const askTypedAnswersSchema = z.object({
  strategy: askTypedSectionSchema,
  scripts: askTypedSectionSchema,
  postingPlan: askTypedSectionSchema,
  monetization: askTypedSectionSchema,
});

export const askVideoExampleSchema = z.object({
  title: z.string().min(1),
  hook: z.string().min(1),
  shotList: z.array(z.string().min(1)).min(1),
  lengthSeconds: z.number().int().positive(),
  platform: z.enum(["instagram", "linkedin", "tiktok", "youtube", "generic"]),
  status: z.enum(["brief_only", "queued", "generated", "not_configured"]),
  code: z.literal("AUTH_REQUIRED").optional(),
  reason: z.literal("VIDEO_PROVIDER_NOT_CONFIGURED").optional(),
  userFacingMessage: z.string().optional(),
  assetId: z.string().optional(),
  url: z.string().optional(),
});

const typedResultFields = {
  typedAnswers: askTypedAnswersSchema.optional(),
  videoExamples: z.array(askVideoExampleSchema).optional(),
};

/** Source + finding cards — kept on the payload for ops/quality; default Ask UI does not list them. */
export const evidenceSourceSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  author: z.string().optional(),
  platform: z.string().optional(),
});

export const evidenceFindingSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: z.string(),
  evidenceExcerpt: z.string().optional(),
  sourceTitle: z.string().optional(),
  claimKind: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const quickAnswerSchema = z.object({
  mode: z.literal("quick"),
  answer: z.string().min(1),
  researchJobId: z.string().optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  sources: z.array(evidenceSourceSchema).optional(),
  ...typedResultFields,
});

export const executiveAnswerSchema = z.object({
  mode: z.literal("executive"),
  keyFinding: z.string().min(1),
  whatMatters: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
  recommendation: z.string().min(1).optional(),
  researchJobId: z.string().optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  sources: z.array(evidenceSourceSchema).optional(),
  ...typedResultFields,
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
  sourceUrl: z.string().optional(),
  evidenceExcerpt: z.string().optional(),
});

export const actionAnswerSchema = z.object({
  mode: z.literal("action"),
  actions: z.array(actionItemSchema).min(1),
  researchJobId: z.string().optional(),
  summary: z.string().optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  sources: z.array(evidenceSourceSchema).optional(),
  ...typedResultFields,
});

export const deepAnswerSchema = z.object({
  mode: z.literal("deep"),
  executiveSummary: z.string().min(1),
  method: z.string().optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  sources: z.array(evidenceSourceSchema).optional(),
  contradictions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  caveats: z.array(z.string()).optional(),
  businessImplications: z.string().optional(),
  marketImplications: z.string().optional(),
  recommendations: z.array(z.string()).optional(),
  nextActions: z.array(z.string()).optional(),
  researchJobId: z.string().optional(),
  ...typedResultFields,
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
export type AskTypedAnswers = z.infer<typeof askTypedAnswersSchema>;
export type AskTypedSection = z.infer<typeof askTypedSectionSchema>;
export type AskVideoExample = z.infer<typeof askVideoExampleSchema>;
