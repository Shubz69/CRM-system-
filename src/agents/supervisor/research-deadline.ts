/**
 * Deadline-aware budgeting for research pipelines.
 *
 * Product latency (2026-09-14):
 * - Quick Ask research: a few seconds (hard cap RESEARCH_QUICK_CEILING_MS).
 * - Even hard/Deep queries: finish or PARTIAL within RESEARCH_HARD_CEILING_MS (~30s).
 * - Prefer source-backed PARTIAL over long empty waits / extra LLM passes.
 *
 * Mandatory path: retrieval → (optional extract) → grounding → RQS attach.
 * Optional: analyst / critic — skipped when remaining wall-clock cannot
 * cover them without blowing the ceiling.
 */

/** Agents that enrich narrative after grounded research + RQS. */
export const OPTIONAL_RESEARCH_ENRICHMENT_AGENTS = new Set(["analyst", "critic"]);

/** Agents that produce grounded research evidence eligible for early RQS. */
export const RESEARCH_EVIDENCE_AGENTS = new Set(["research", "social_listening"]);

/**
 * Quick research hard cap (ms). Search + persist + optional cheap extract when
 * remaining wall-clock allows. Analyst/critic stay skipped.
 * Aligns with Ask QUICK P90 ≤12s — not an unbounded wait.
 */
export const RESEARCH_QUICK_CEILING_MS = 12_000;

/** FAST extract only when at least this much wall-clock remains after search. */
export const RESEARCH_FAST_EXTRACT_MIN_MS = 2_500;

/**
 * Even Deep/hard Ask research must PARTIAL or complete within this execute budget.
 * Supervisor wall-clock for research plans is aligned (see researchWallClockCapSeconds).
 */
export const RESEARCH_HARD_CEILING_MS = 30_000;

/**
 * Per-adapter source fetch timeout (ms). Unbounded Tavily/Apify waits are not allowed.
 * FAST must still be long enough for one Tavily/Exa round-trip from Vercel
 * serverless — 3.5s aborted plant-hire searches before any URL returned.
 */
export const RESEARCH_SOURCE_FETCH_MS = {
  FAST: 7_000,
  STANDARD: 6_000,
  DEEP: 7_000,
} as const;

/** Skip structured extract LLM when remaining time is below this. */
export const RESEARCH_EXTRACT_MIN_MS = 5_000;

export const RESEARCH_QUERY_CAP = {
  FAST: 1,
  STANDARD: 3,
  DEEP: 4,
} as const;

export const RESEARCH_SOURCE_CAP = {
  FAST: 5,
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
  return answerMode === "QUICK" ? Math.ceil(RESEARCH_QUICK_CEILING_MS / 1000) + 4 : 30;
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
