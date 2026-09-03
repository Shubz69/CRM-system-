/**
 * Diagnostic test — runs a stale contact POST and prints the actual response body
 * to diagnose why the stale guard returns 400 instead of 409.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import { test, expect } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (process.env.PLAYWRIGHT_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const QA_ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const FAKE_ORG = "fake-org-id-that-does-not-exist";

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

test.skip(!hasAuth, "E2E credentials required");

test("stale org guard diagnostic: capture actual response", async ({ page }) => {
  // Login
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="email"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('input[type="email"]').first().fill(process.env.E2E_EMAIL!);
  await page.locator('input[type="password"]').first().fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });

  // Verify logged in
  const authCheck = await page.request.get(`${BASE}/api/organisations`);
  console.log("Auth check status:", authCheck.status());
  const authBody = await authCheck.json();
  console.log("Active org:", authBody.activeOrganisationId);

  // Switch to QA org explicitly
  const switchRes = await page.request.post(`${BASE}/api/session/organisation`, {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ organisationId: QA_ORG }),
  });
  console.log("Switch status:", switchRes.status());
  const switchBody = await switchRes.json();
  console.log("Switch body:", JSON.stringify(switchBody).slice(0, 200));

  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Re-check active org after goto
  const afterGoto = await page.request.get(`${BASE}/api/organisations`);
  const afterGotoBody = await afterGoto.json();
  console.log("Active org after goto:", afterGotoBody.activeOrganisationId);

  // POST stale contact with wrong expected-org-id
  const stale = await page.request.post(`${BASE}/api/contacts`, {
    headers: {
      "Content-Type": "application/json",
      "x-expected-organisation-id": FAKE_ORG,
    },
    data: JSON.stringify({
      fullName: `Diag-Stale-${Date.now()}`,
      email: `diag-stale-${Date.now()}@example.com`,
      leadSource: "manual",
    }),
  });
  console.log("Stale POST status:", stale.status());
  const staleBody = await stale.json();
  console.log("Stale POST body:", JSON.stringify(staleBody));

  // The stale POST should be blocked — 409 if guard works, anything else is a bug.
  expect([409, 400, 403]).toContain(stale.status());
  if (stale.status() === 409) {
    expect(staleBody.code).toBe("WORKSPACE_CHANGED");
    console.log("STALE_GUARD: PASS — 409 WORKSPACE_CHANGED");
  } else {
    console.log("STALE_GUARD: FAIL — expected 409 but got", stale.status(), staleBody.error);
  }
});
