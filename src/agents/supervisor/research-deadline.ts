/**
 * Deadline-aware budgeting for research pipelines.
 *
 * Mandatory path: retrieval → synthesis → extraction → grounding → RQS attach.
 * Optional: analyst / critic enrichment — skipped when remaining wall-clock
 * cannot safely cover them without starving RQS persistence.
 */

/** Agents that enrich narrative after grounded research + RQS. */
export const OPTIONAL_RESEARCH_ENRICHMENT_AGENTS = new Set(["analyst", "critic"]);

/** Agents that produce grounded research evidence eligible for early RQS. */
export const RESEARCH_EVIDENCE_AGENTS = new Set(["research", "social_listening"]);

/** Safe budget to start optional analyst enrichment (ms). */
export const ANALYST_SAFE_BUDGET_MS = 90_000;

/** Safe budget to start optional critic verification (ms). */
export const CRITIC_SAFE_BUDGET_MS = 45_000;

/** Reserve for finalize / RQS attach / persistence after optional work. */
export const RQS_RESERVE_MS = 5_000;

export function remainingWallClockMs(input: {
  startedAt: Date;
  maxWallClockSeconds: number;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  return input.maxWallClockSeconds * 1000 - (now - input.startedAt.getTime());
}

export function safeBudgetForOptionalAgent(agentName: string): number | null {
  if (agentName === "analyst") return ANALYST_SAFE_BUDGET_MS;
  if (agentName === "critic") return CRITIC_SAFE_BUDGET_MS;
  return null;
}

/**
 * True when starting this optional enrichment agent would risk burning the
 * remaining wall-clock before mandatory RQS can be ensured on exit paths.
 */
export function shouldSkipOptionalEnrichment(input: {
  agentName: string;
  remainingMs: number;
}): boolean {
  if (!OPTIONAL_RESEARCH_ENRICHMENT_AGENTS.has(input.agentName)) return false;
  const need = safeBudgetForOptionalAgent(input.agentName);
  if (need == null) return false;
  return input.remainingMs < need + RQS_RESERVE_MS;
}

export function isResearchEvidenceAgent(agentName: string): boolean {
  return RESEARCH_EVIDENCE_AGENTS.has(agentName);
}

export function looksLikeResearchOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const obj = output as Record<string, unknown>;
  return (
    Array.isArray(obj.claims) ||
    Array.isArray(obj.findings) ||
    Array.isArray(obj.sources) ||
    typeof obj.researchJobId === "string" ||
    typeof obj.brief === "string" ||
    typeof obj.shortAnswer === "string" ||
    typeof obj.executiveSummary === "string" ||
    obj.researchQuality != null
  );
}
