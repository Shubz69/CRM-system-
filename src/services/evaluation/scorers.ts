/**
 * Phase 17 — Deterministic scorers.
 * Real structural checks (not LLM judges). No invented accuracy.
 */

export type ScorerResult = {
  scorer: string;
  passed: boolean;
  score: number | null;
  detail: string;
  metrics: Record<string, number | boolean | string | null>;
};

const OPPORTUNITY_REQUIRED = ["title", "organisationId", "status"] as const;
const PREFERENCE_REQUIRED = ["subjectKind", "signal"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Schema validity — required keys present for known synthetic schemas.
 */
export function scoreSchemaValidity(input: {
  schema?: unknown;
  payload?: unknown;
}): ScorerResult {
  const schema = String(input.schema ?? "");
  const payload = asRecord(input.payload);
  if (!payload) {
    return {
      scorer: "schema_validity",
      passed: false,
      score: 0,
      detail: "payload must be an object",
      metrics: { valid: false },
    };
  }

  let required: readonly string[] = [];
  if (schema === "opportunity_v1") required = OPPORTUNITY_REQUIRED;
  else if (schema === "preference_v1") required = PREFERENCE_REQUIRED;
  else {
    return {
      scorer: "schema_validity",
      passed: false,
      score: 0,
      detail: `Unknown schema: ${schema || "(empty)"}`,
      metrics: { valid: false },
    };
  }

  const missing = required.filter(
    (k) => payload[k] == null || (typeof payload[k] === "string" && !String(payload[k]).trim()),
  );
  const valid = missing.length === 0;
  return {
    scorer: "schema_validity",
    passed: valid,
    score: valid ? 1 : 0,
    detail: valid ? "Required fields present" : `Missing: ${missing.join(", ")}`,
    metrics: { valid, missingCount: missing.length },
  };
}

/**
 * Tenant correctness — request org must match output org; citations must not leak.
 */
export function scoreTenantCorrectness(input: {
  requestOrganisationId?: unknown;
  outputOrganisationId?: unknown;
  citedOrganisationIds?: unknown;
}): ScorerResult {
  const requestOrg = String(input.requestOrganisationId ?? "");
  const outputOrg = String(input.outputOrganisationId ?? "");
  const cited = Array.isArray(input.citedOrganisationIds)
    ? input.citedOrganisationIds.map((x) => String(x))
    : [];

  if (!requestOrg) {
    return {
      scorer: "tenant_correctness",
      passed: false,
      score: 0,
      detail: "requestOrganisationId required",
      metrics: { correct: false },
    };
  }

  const outputMatch = outputOrg === requestOrg;
  const leak = cited.filter((id) => id !== requestOrg);
  const correct = outputMatch && leak.length === 0;

  return {
    scorer: "tenant_correctness",
    passed: correct,
    score: correct ? 1 : 0,
    detail: correct
      ? "Tenant boundary held"
      : !outputMatch
        ? `output org ${outputOrg || "(empty)"} ≠ request ${requestOrg}`
        : `Cross-tenant citation(s): ${leak.join(", ")}`,
    metrics: {
      correct,
      outputMatch,
      leakCount: leak.length,
    },
  };
}

type ClaimRow = { id?: string; text?: string; citationIds?: unknown };

/**
 * Citation coverage — fraction of claims with ≥1 citation id.
 * Stub that is a real check (not a placeholder that always passes).
 */
export function scoreCitationCoverage(input: { claims?: unknown }): ScorerResult {
  const claims = Array.isArray(input.claims) ? (input.claims as ClaimRow[]) : null;
  if (!claims || claims.length === 0) {
    return {
      scorer: "citation_coverage",
      passed: false,
      score: 0,
      detail: "No claims to score",
      metrics: { coverage: 0, claimCount: 0, citedCount: 0 },
    };
  }

  let citedCount = 0;
  for (const c of claims) {
    const ids = Array.isArray(c.citationIds)
      ? c.citationIds.filter((x) => x != null && String(x).trim() !== "")
      : [];
    if (ids.length > 0) citedCount += 1;
  }
  const coverage = citedCount / claims.length;
  const passed = coverage >= 1;

  return {
    scorer: "citation_coverage",
    passed,
    score: coverage,
    detail: `${citedCount}/${claims.length} claims cited (coverage=${coverage})`,
    metrics: { coverage, claimCount: claims.length, citedCount },
  };
}

export function runScorer(
  scorer: "schema_validity" | "tenant_correctness" | "citation_coverage",
  input: Record<string, unknown>,
): ScorerResult {
  switch (scorer) {
    case "schema_validity":
      return scoreSchemaValidity(input);
    case "tenant_correctness":
      return scoreTenantCorrectness(input);
    case "citation_coverage":
      return scoreCitationCoverage(input);
    default:
      return {
        scorer: String(scorer),
        passed: false,
        score: null,
        detail: `Unknown scorer`,
        metrics: {},
      };
  }
}

/**
 * Compare scorer output against fixture expect (boolean/number equality with tolerance).
 */
export function matchesExpect(
  result: ScorerResult,
  expect: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(expect)) {
    const actual =
      key in result.metrics
        ? result.metrics[key]
        : key === "passed"
          ? result.passed
          : key === "score"
            ? result.score
            : undefined;
    if (typeof expected === "number" && typeof actual === "number") {
      if (Math.abs(expected - actual) > 1e-9) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}
