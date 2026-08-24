/**
 * Phase 17 — Evaluation datasets / cases.
 * Fixtures must never embed secrets, tokens, or live credentials.
 */

import type { LearningSignalKind } from "@/services/evaluation/types";
import {
  SIGNAL_EMPIRICAL_PERFORMANCE,
  SIGNAL_USER_PREFERENCE,
} from "@/services/evaluation/types";

export type EvalFixtureCase = {
  id: string;
  name: string;
  /** Deterministic scorer key */
  scorer:
    | "schema_validity"
    | "tenant_correctness"
    | "citation_coverage";
  /** Synthetic input — no secrets */
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
  /** Which learning signal this case relates to (documentation / API clarity). */
  signalKind: LearningSignalKind;
};

const FORBIDDEN_KEY_FRAGMENTS = [
  "api_key",
  "apikey",
  "secret",
  "password",
  "token",
  "authorization",
  "private_key",
  "encryption_key",
  "bearer",
];

/**
 * Reject fixtures that look like they contain secrets.
 * Checks keys (case-insensitive) and common secret-looking string values.
 */
export function assertNoSecretsInFixture(value: unknown, path = "root"): void {
  if (value == null) return;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (
      lower.startsWith("sk-") ||
      lower.startsWith("ghp_") ||
      lower.includes("-----begin") ||
      /Bearer\s+[A-Za-z0-9._-]{20,}/i.test(value)
    ) {
      throw new Error(`Fixture contains secret-like string at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretsInFixture(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      if (FORBIDDEN_KEY_FRAGMENTS.some((f) => keyLower.includes(f))) {
        throw new Error(`Fixture key looks like a secret field: ${path}.${k}`);
      }
      assertNoSecretsInFixture(v, `${path}.${k}`);
    }
  }
}

/** Built-in synthetic cases — safe for CI; no live org data required. */
export const BUILTIN_EVAL_FIXTURES: EvalFixtureCase[] = [
  {
    id: "schema_opportunity_ok",
    name: "Opportunity payload has required fields",
    scorer: "schema_validity",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      schema: "opportunity_v1",
      payload: {
        title: "Stale deal risk",
        organisationId: "org_fixture_a",
        status: "OPEN",
        confidenceBand: "MEDIUM",
      },
    },
    expect: { valid: true },
  },
  {
    id: "schema_opportunity_missing",
    name: "Opportunity payload missing title fails",
    scorer: "schema_validity",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      schema: "opportunity_v1",
      payload: {
        organisationId: "org_fixture_a",
        status: "OPEN",
      },
    },
    expect: { valid: false },
  },
  {
    id: "tenant_match",
    name: "Output org matches request org",
    scorer: "tenant_correctness",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      requestOrganisationId: "org_fixture_a",
      outputOrganisationId: "org_fixture_a",
      citedOrganisationIds: ["org_fixture_a"],
    },
    expect: { correct: true },
  },
  {
    id: "tenant_cross_leak",
    name: "Cross-tenant citation fails",
    scorer: "tenant_correctness",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      requestOrganisationId: "org_fixture_a",
      outputOrganisationId: "org_fixture_a",
      citedOrganisationIds: ["org_fixture_a", "org_fixture_b"],
    },
    expect: { correct: false },
  },
  {
    id: "citations_full",
    name: "All claims have citations",
    scorer: "citation_coverage",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      claims: [
        { id: "c1", text: "Deal X is stale", citationIds: ["ev1"] },
        { id: "c2", text: "KPI at risk", citationIds: ["ev2"] },
      ],
    },
    expect: { coverage: 1 },
  },
  {
    id: "citations_partial",
    name: "Uncited claim lowers coverage",
    scorer: "citation_coverage",
    signalKind: SIGNAL_EMPIRICAL_PERFORMANCE,
    input: {
      claims: [
        { id: "c1", text: "Deal X is stale", citationIds: ["ev1"] },
        { id: "c2", text: "Unverified claim", citationIds: [] },
      ],
    },
    expect: { coverage: 0.5 },
  },
  {
    id: "preference_thumbs",
    name: "Preference case labelled USER_PREFERENCE (not empirical)",
    scorer: "schema_validity",
    signalKind: SIGNAL_USER_PREFERENCE,
    input: {
      schema: "preference_v1",
      payload: { subjectKind: "recommendation", signal: "thumbs_up", rating: 5 },
    },
    expect: { valid: true },
  },
];

export function listBuiltinEvalFixtures(): EvalFixtureCase[] {
  for (const c of BUILTIN_EVAL_FIXTURES) {
    assertNoSecretsInFixture(c.input, c.id);
    assertNoSecretsInFixture(c.expect, `${c.id}.expect`);
  }
  return BUILTIN_EVAL_FIXTURES.map((c) => ({ ...c }));
}

export function getEvalFixture(id: string): EvalFixtureCase | undefined {
  return listBuiltinEvalFixtures().find((c) => c.id === id);
}
