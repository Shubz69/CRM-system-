import { config as loadEnv } from "dotenv";
import path from "path";
import { test, expect } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

/**
 * Focused Round 3 workspace + pipeline guards.
 * Requires E2E credentials for Automated QA — if auth is missing, mark BLOCKED (do not claim 0 as quality).
 */

const BASE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const QA_ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
// Use a clearly fake org ID to simulate a stale form from a different workspace.
// This tests the guard without requiring cross-org membership.
const STALE_FAKE_ORG = process.env.E2E_PLATFORM_ORG_ID || "fake-stale-org-id-for-guard-test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Wait for email input to be available.
  await page.locator('input[type="email"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('input[type="email"]').first().fill(process.env.E2E_EMAIL!);
  await page.locator('input[type="password"]').first().fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
  // Verify session is established by checking the API.
  const check = await page.request.get(`${BASE}/api/organisations`);
  if (check.status() === 401) {
    throw new Error(`LOGIN_FAILED: POST /login returned 401 after redirect. Auth not established.`);
  }
}

test.describe("Round 3 org switch + stale mutation", () => {
  test.skip(!hasAuth, "BLOCKED: E2E_EMAIL/E2E_PASSWORD not configured for Automated QA");

  test("POST organisation switch readback matches GET orgs and auth session", async ({ page }) => {
    await signIn(page);

    // Switch to QA org (the only org the E2E user is a member of).
    const res = await page.request.post(`${BASE}/api/session/organisation`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ organisationId: QA_ORG }),
    });
    const json = await res.json();
    expect(res.status(), json.error || "switch").toBe(200);
    expect(json.verified).toBe(true);
    expect(json.organisationId).toBe(QA_ORG);
    expect(json.activeOrganisationId).toBe(QA_ORG);

    // Force JWT refresh by reloading a page that uses the session.
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const orgs = await page.request.get(`${BASE}/api/organisations`);
    const orgsJson = await orgs.json();
    expect(orgsJson.activeOrganisationId).toBe(QA_ORG);

    const session = await page.request.get(`${BASE}/api/auth/session`);
    const sessionJson = await session.json();
    expect(sessionJson.user?.organisationId).toBe(QA_ORG);
  });

  test("stale expectedOrganisationId blocks contact create with 409", async ({ page }) => {
    await signIn(page);

    await page.request.post(`${BASE}/api/session/organisation`, {
      data: { organisationId: QA_ORG },
    });
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Send a contact POST with a stale/wrong expected org ID — guard must reject it.
    const stale = await page.request.post(`${BASE}/api/contacts`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": STALE_FAKE_ORG,
      },
      data: JSON.stringify({
        fullName: `QA-stale-form-${Date.now()}`,
        email: `stale-${Date.now()}@example.com`,
        leadSource: "manual",
      }),
    });
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("WORKSPACE_CHANGED");
  });
});
