import type { z } from "zod";
import type { FormalAiTier } from "@/lib/ai-models";

/** Formal cost tier — never shown to end users. */
export type AgentTier = FormalAiTier;

export type AgentContext = {
  organisationId: string;
  agentRunId: string;
  agentStepId: string;
  /**
   * Optional org knowledge packet for grounding (Phase 2 Memory).
   * Provenance titles are separate — never treat as verified external citations.
   */
  knowledgeContext?: string | null;
  knowledgeDocumentTitles?: string[];
  knowledgeRetrievalMode?: "hybrid" | "lexical" | "none";
  /** Prior Ask episodes + admin preferences — not approved Knowledge. */
  episodicContext?: string | null;
};

export type AgentExecuteResult<TOut> = {
  output: TOut;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costCents: number;
};

/**
 * Common agent contract. Call sites use the registry — never hard-code agents.
 * `userFacingLabel` is required: it is the only step text users ever see.
 */
export type Agent<TIn = unknown, TOut = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
  tier: AgentTier;
  /** Rough pre-dispatch estimate in cents for spend gating. */
  estimateCostCents: (input: TIn) => number;
  /**
   * Plain English for a non-technical reader, given current inputs.
   * Empty or auto-generated junk is a bug.
   */
  userFacingLabel: (input: TIn) => string;
  execute: (input: TIn, ctx: AgentContext) => Promise<AgentExecuteResult<TOut>>;
};

/** Heterogeneous registry entry — agents differ in In/Out; callers narrow via schemas. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for mixed agent map
export type AnyAgent = Agent<any, any>;
