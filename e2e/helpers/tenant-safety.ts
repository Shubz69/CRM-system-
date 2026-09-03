/**
 * Production E2E tenant isolation — fail closed before any mutation.
 *
 * Required env for mutating hosted/production tests:
 *   E2E_TARGET_ORG_ID       — exact organisation id of the disposable QA tenant
 *   E2E_TARGET_ORG_NAME     — exact display name (e.g. "Agent Desk Automated QA")
 *   E2E_ALLOW_MUTATIONS     — must be the string "true"
 *
 * Optional:
 *   E2E_TEST_RUN_ID         — run id for disposable entity names (default: timestamp)
 *
 * Disposable QA entity naming: `E2E-<runId>-…` (prefer metadata/testRunId when APIs support it).
 *
 * Never infer the mutation target from whichever org is active after login alone.
 * Shobhit Agency = real business data only — mutating Playwright must not run there.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const FORBIDDEN_PRODUCTION_ORG_NAME = "Shobhit Agency";
export const DEFAULT_QA_ORG_NAME = "Agent Desk Automated QA";

export type ActiveOrganisation = {
  id: string;
  name: string;
};

export function e2eTestRunId(): string {
  return (process.env.E2E_TEST_RUN_ID || "").trim() || String(Date.now());
}

/** Disposable QA entity name prefix: E2E-<runId>- */
export function e2eNamePrefix(runId = e2eTestRunId()): string {
  return `E2E-${runId}-`;
}

export function e2eDisposableName(kind: string, runId = e2eTestRunId()): string {
  const safe = kind.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "entity";
  return `${e2eNamePrefix(runId)}${safe}`;
}

export function mutationsExplicitlyAllowed(): boolean {
  return process.env.E2E_ALLOW_MUTATIONS === "true";
}

export function configuredQaOrg(): { id: string; name: string } {
  return {
    id: (process.env.E2E_TARGET_ORG_ID || "").trim(),
    name: (process.env.E2E_TARGET_ORG_NAME || "").trim(),
  };
}

export async function fetchActiveOrganisation(
  request: APIRequestContext,
  baseUrl: string,
): Promise<ActiveOrganisation> {
  const res = await request.get(`${baseUrl.replace(/\/$/, "")}/api/organisations`);
  const status = res.status();
  const json = (await res.json().catch(() => null)) as {
    activeOrganisationId?: string;
    organisations?: { id: string; name: string; isActive?: boolean }[];
  } | null;

  if (status !== 200 || !json) {
    throw new Error(
      `TENANT_SAFETY_FAIL_CLOSED: GET /api/organisations returned ${status} — cannot verify QA tenant`,
    );
  }

  const activeId = json.activeOrganisationId || "";
  const active =
    json.organisations?.find((o) => o.isActive || o.id === activeId) ||
    json.organisations?.find((o) => o.id === activeId);

  if (!activeId || !active?.name) {
    throw new Error(
      "TENANT_SAFETY_FAIL_CLOSED: no active organisation in session — cannot verify QA tenant",
    );
  }

  return { id: active.id || activeId, name: active.name };
}

/**
 * Hard gate before any production mutating action.
 * Requires E2E_ALLOW_MUTATIONS=true AND exact org id+name match.
 * Never treats "whatever org we landed in after login" as sufficient.
 */
export async function assertSafeQaTenantForMutations(
  request: APIRequestContext,
  baseUrl: string,
): Promise<ActiveOrganisation> {
  if (!mutationsExplicitlyAllowed()) {
    throw new Error(
      "TENANT_SAFETY_FAIL_CLOSED: E2E_ALLOW_MUTATIONS must be exactly 'true' before mutating production",
    );
  }

  const expected = configuredQaOrg();
  if (!expected.id || !expected.name) {
    throw new Error(
      "TENANT_SAFETY_FAIL_CLOSED: E2E_TARGET_ORG_ID and E2E_TARGET_ORG_NAME must both be set explicitly — do not infer from login",
    );
  }

  const active = await fetchActiveOrganisation(request, baseUrl);

  if (/^shobhit agency$/i.test(active.name.trim())) {
    throw new Error(
      `TENANT_SAFETY_FAIL_CLOSED: active org is "${FORBIDDEN_PRODUCTION_ORG_NAME}" — mutations forbidden on real business tenant`,
    );
  }

  if (active.id !== expected.id || active.name !== expected.name) {
    throw new Error(
      `TENANT_SAFETY_FAIL_CLOSED: active org id/name do not match configured QA tenant (activeName=${JSON.stringify(active.name)}; expectedName=${JSON.stringify(expected.name)}; idMatch=${active.id === expected.id})`,
    );
  }

  expect(active.id, "QA org id").toBe(expected.id);
  expect(active.name, "QA org name").toBe(expected.name);
  return active;
}

/** UI helper: same gate using the page's request context. */
export async function assertSafeQaTenantForMutationsOnPage(
  page: Page,
  baseUrl: string,
): Promise<ActiveOrganisation> {
  return assertSafeQaTenantForMutations(page.request, baseUrl);
}
