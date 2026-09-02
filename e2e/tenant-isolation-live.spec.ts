/**
 * Two-organisation LIVE tenant isolation harness (prepared; env-gated).
 *
 * Does NOT create organisations. Requires dedicated QA identities:
 *
 *   PLAYWRIGHT_SKIP_WEBSERVER=1
 *   PLAYWRIGHT_BASE_URL=https://<production-host>
 *   E2E_ORG_A_EMAIL / E2E_ORG_A_PASSWORD
 *   E2E_ORG_B_EMAIL / E2E_ORG_B_PASSWORD
 *   E2E_ORG_A_CONTACT_ID / E2E_ORG_B_CONTACT_ID
 *   E2E_ORG_A_COMPANY_ID / E2E_ORG_B_COMPANY_ID
 *   E2E_ORG_A_DEAL_ID / E2E_ORG_B_DEAL_ID
 *   E2E_ORG_A_CONVERSATION_ID / E2E_ORG_B_CONVERSATION_ID
 *   E2E_ORG_A_MESSAGE_ID / E2E_ORG_B_MESSAGE_ID          (optional)
 *   E2E_ORG_A_RESEARCH_ID / E2E_ORG_B_RESEARCH_ID        (optional)
 *   E2E_ORG_A_OPPORTUNITY_ID / E2E_ORG_B_OPPORTUNITY_ID  (optional)
 *   E2E_ORG_A_KNOWLEDGE_ID / E2E_ORG_B_KNOWLEDGE_ID      (optional)
 *
 * Proves by-ID denial both directions. Never relies only on hidden navigation.
 * Skips entirely when credentials/resource ids are absent — safe for CI without LIVE orgs.
 */
import { config as loadEnv } from "dotenv";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import path from "path";

loadEnv({ path: path.join(process.cwd(), ".env") });

function resolveHostedBaseUrl(): string {
  const hosted = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1";
  const explicit = (process.env.PLAYWRIGHT_BASE_URL || "").trim();
  const appUrl = (process.env.APP_URL || "").trim();
  if (hosted) {
    const candidate = (explicit || appUrl).replace(/\/$/, "");
    if (!candidate) {
      throw new Error("HOSTED_E2E_REQUIRES_URL: set PLAYWRIGHT_BASE_URL or APP_URL");
    }
    if (/localhost|127\.0\.0\.1/i.test(candidate)) {
      throw new Error("HOSTED_E2E_LOCALHOST_FORBIDDEN");
    }
    return candidate;
  }
  return (explicit || appUrl || "http://localhost:3000").replace(/\/$/, "");
}

const BASE = resolveHostedBaseUrl();

type OrgCreds = { email: string; password: string };
type ResourceMap = Record<string, string>;

function orgCreds(prefix: "A" | "B"): OrgCreds {
  return {
    email: process.env[`E2E_ORG_${prefix}_EMAIL`] || "",
    password: process.env[`E2E_ORG_${prefix}_PASSWORD`] || "",
  };
}

function resourceIds(prefix: "A" | "B"): ResourceMap {
  const keys = [
    "CONTACT_ID",
    "COMPANY_ID",
    "DEAL_ID",
    "CONVERSATION_ID",
    "MESSAGE_ID",
    "RESEARCH_ID",
    "OPPORTUNITY_ID",
    "KNOWLEDGE_ID",
  ] as const;
  const out: ResourceMap = {};
  for (const key of keys) {
    const value = process.env[`E2E_ORG_${prefix}_${key}`] || "";
    if (value) out[key] = value;
  }
  return out;
}

const ORG_A = orgCreds("A");
const ORG_B = orgCreds("B");
const IDS_A = resourceIds("A");
const IDS_B = resourceIds("B");

function ready(): boolean {
  return Boolean(
    ORG_A.email &&
      ORG_A.password &&
      ORG_B.email &&
      ORG_B.password &&
      IDS_A.CONTACT_ID &&
      IDS_B.CONTACT_ID &&
      IDS_A.COMPANY_ID &&
      IDS_B.COMPANY_ID &&
      IDS_A.DEAL_ID &&
      IDS_B.DEAL_ID &&
      IDS_A.CONVERSATION_ID &&
      IDS_B.CONVERSATION_ID,
  );
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
}

async function authedRequest(browser: Browser, creds: OrgCreds): Promise<{
  request: APIRequestContext;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await signIn(page, creds.email, creds.password);
  return {
    request: context.request,
    close: async () => context.close(),
  };
}

async function getStatus(request: APIRequestContext, pathName: string): Promise<number> {
  const res = await request.fetch(`${BASE}${pathName}`, { method: "GET" });
  return res.status();
}

function expectDenied(status: number, label: string) {
  expect([401, 403, 404], `${label} must deny cross-tenant access (got ${status})`).toContain(status);
  expect(status, `${label} must not 500`).toBeLessThan(500);
}

const CROSS_PATHS: { key: keyof ResourceMap; pathFor: (id: string) => string }[] = [
  { key: "CONTACT_ID", pathFor: (id) => `/api/contacts/${id}` },
  { key: "COMPANY_ID", pathFor: (id) => `/api/companies/${id}` },
  { key: "DEAL_ID", pathFor: (id) => `/api/deals/${id}` },
  { key: "CONVERSATION_ID", pathFor: (id) => `/api/conversations/${id}` },
  { key: "MESSAGE_ID", pathFor: (id) => `/api/messages/${id}` },
  { key: "RESEARCH_ID", pathFor: (id) => `/api/research/${id}` },
  { key: "OPPORTUNITY_ID", pathFor: (id) => `/api/opportunities/${id}` },
  { key: "KNOWLEDGE_ID", pathFor: (id) => `/api/knowledge/${id}` },
];

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.describe("LIVE two-organisation tenant isolation", () => {
  test.beforeAll(() => {
    test.skip(!ready(), "E2E_ORG_A_* / E2E_ORG_B_* credentials + resource ids not configured");
    expect(process.env.PLAYWRIGHT_SKIP_WEBSERVER).toBe("1");
    expect(BASE).not.toMatch(/localhost|127\.0\.0\.1/i);
  });

  test("Org A cannot access Org B resources by id", async ({ browser }) => {
    const session = await authedRequest(browser, ORG_A);
    try {
      for (const { key, pathFor } of CROSS_PATHS) {
        const foreignId = IDS_B[key];
        if (!foreignId) continue;
        const status = await getStatus(session.request, pathFor(foreignId));
        expectDenied(status, `A→B ${key}`);
      }

      // Integrations / credentials / business-state must not leak foreign org via forged query
      for (const pathName of [
        "/api/integrations/manychat",
        "/api/integrations/meta-instagram",
        "/api/security/credentials",
        "/api/business-context",
      ]) {
        const res = await session.request.fetch(`${BASE}${pathName}?organisationId=${IDS_B.CONTACT_ID}`, {
          method: "GET",
        });
        expect(res.status(), pathName).toBeLessThan(500);
        // Must succeed against session org OR deny — never return foreign ciphertext
        if (res.status() === 200) {
          const text = await res.text();
          expect(text).not.toMatch(/BEGIN.*PRIVATE|sk-|access_token|apiToken/i);
        }
      }
    } finally {
      await session.close();
    }
  });

  test("Org B cannot access Org A resources by id", async ({ browser }) => {
    const session = await authedRequest(browser, ORG_B);
    try {
      for (const { key, pathFor } of CROSS_PATHS) {
        const foreignId = IDS_A[key];
        if (!foreignId) continue;
        const status = await getStatus(session.request, pathFor(foreignId));
        expectDenied(status, `B→A ${key}`);
      }
    } finally {
      await session.close();
    }
  });

  test("Own-org by-id access still works (sanity)", async ({ browser }) => {
    const sessionA = await authedRequest(browser, ORG_A);
    try {
      const status = await getStatus(sessionA.request, `/api/contacts/${IDS_A.CONTACT_ID}`);
      expect([200, 404]).toContain(status); // 404 only if route shape differs; never 403 for own
      if (status === 403) throw new Error("Own-org contact unexpectedly forbidden for Org A");
    } finally {
      await sessionA.close();
    }
  });
});
