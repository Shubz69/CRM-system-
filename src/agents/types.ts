import type { z } from "zod";
import type { FormalAiTier } from "@/lib/ai-models";

/** Formal cost tier — never shown to end users. */
export type AgentTier = FormalAiTier;

export type AgentContext = {
  organisationId: string;
  agentRunId: string;
  agentStepId: string;
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

export type AnyAgent = Agent<never, unknown> | Agent<any, any>;
