/**
 * Deadline-aware budgeting for research pipelines.
 *
 * Product latency:
 * - Default / Quick Ask: thorough search + 4-section synthesis inside
 *   RESEARCH_QUICK_CEILING_MS (≤60s wall clock). Everyday CRM Asks stay
 *   near-instant on the non-research path.
 * - Deep / hard queries: finish or PARTIAL within RESEARCH_HARD_CEILING_MS.
 * - Prefer four typed answers over a sources-only dump when time runs out.
 *
 * Mandatory path: retrieval → extract (when remaining time allows) →
 * grounding → 4-section shape → RQS attach.
 * Optional: analyst / critic — skipped when remaining wall-clock cannot
 * cover them without blowing the ceiling.
 */

/** Agents that enrich narrative after grounded research + RQS. */
export const OPTIONAL_RESEARCH_ENRICHMENT_AGENTS = new Set(["analyst", "critic"]);

/** Agents that produce grounded research evidence eligible for early RQS. */
export const RESEARCH_EVIDENCE_AGENTS = new Set(["research", "social_listening"]);

/**
 * Quick / default research hard cap (ms). Search + extract + 4-section answers.
 * Must leave a few seconds of supervisor headroom under a 60s Ask wall clock
 * (Vercel `maxDuration` on /api/ask is 60).
 */
export const RESEARCH_QUICK_CEILING_MS = 52_000;

/**
 * Deep/hard Ask research must PARTIAL or complete within this execute budget.
 * Aligned with the 60s Ask function budget so Deep does not abort earlier than Quick.
 */
export const RESEARCH_HARD_CEILING_MS = 58_000;

/**
 * Per-adapter source fetch timeout (ms). Unbounded Tavily/Apify waits are not allowed.
 * FAST must still be long enough for one Tavily/Exa round-trip from Vercel
 * serverless, and for a parallel second/third query inside the 60s budget.
 */
export const RESEARCH_SOURCE_FETCH_MS = {
  FAST: 12_000,
  STANDARD: 12_000,
  DEEP: 14_000,
} as const;

/** Skip structured extract LLM when remaining time is below this. */
export const RESEARCH_EXTRACT_MIN_MS = 5_000;

export const RESEARCH_QUERY_CAP = {
  FAST: 3,
  STANDARD: 3,
  DEEP: 4,
} as const;

export const RESEARCH_SOURCE_CAP = {
  FAST: 8,
  STANDARD: 8,
  DEEP: 10,
} as const;

/** Only start analyst when at least this much time remains (plus RQS reserve). */
export const ANALYST_SAFE_BUDGET_MS = 10_000;

/** Critic is last-mile and almost never fits a 30s ceiling. */
export const CRITIC_SAFE_BUDGET_MS = 8_000;

/** Reserve for finalize / RQS attach / persistence after optional work. */
export const RQS_RESERVE_MS = 2_000;

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

/** Supervisor wall-clock cap (seconds) for research / social-listening plans. */
export function researchWallClockCapSeconds(answerMode: string | null | undefined): number {
  void answerMode;
  return 60;
}

export function isResearchPlanStepName(agentName: string): boolean {
  return RESEARCH_EVIDENCE_AGENTS.has(agentName);
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return onTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
