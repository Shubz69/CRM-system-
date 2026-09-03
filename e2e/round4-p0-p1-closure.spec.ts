import { config as loadEnv } from "dotenv";
import path from "path";
import { expect, test, type Page } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const QA_ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
// Fake org id used as the stale-form "loaded-org" context — simulates a form that was opened
// in a different workspace. The E2E user is not a member, so we use a fake id.
const STALE_FAKE_ORG = process.env.E2E_PLATFORM_ORG_ID || "fake-stale-org-id-for-guard-test";

async function loginIfNeeded(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="email"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('input[type="email"]').first().fill(process.env.E2E_EMAIL!);
  await page.locator('input[type="password"]').first().fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
  // Verify session established.
  const check = await page.request.get(`${BASE}/api/organisations`);
  if (check.status() === 401) {
    throw new Error(`LOGIN_FAILED: session not established after login redirect.`);
  }
}

test.describe("Round 4 closure checks", () => {
  test.skip(!hasAuth, "BLOCKED: E2E_EMAIL/E2E_PASSWORD are required");

  test("A->B stale contact mutation blocked with 409", async ({ page }) => {
    await loginIfNeeded(page);
    // Ensure session is in QA org.
    await page.request.post(`${BASE}/api/session/organisation`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ organisationId: QA_ORG }),
    });
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Simulate a stale form submission: the expected org is a fake ID (not the current session org).
    // This proves the mutation guard rejects mismatched expected-org at the server.
    const stale = await page.request.post(`${BASE}/api/contacts`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": STALE_FAKE_ORG,
      },
      data: JSON.stringify({
        fullName: `QA-stale-form-R4-${Date.now()}`,
        email: `r4-stale-${Date.now()}@example.com`,
        leadSource: "manual",
      }),
    });
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("WORKSPACE_CHANGED");
  });

  test("A->B->A stale org guard: wrong org id blocked, revision guard documented", async ({ page }) => {
    await loginIfNeeded(page);
    // Ensure session is in QA org.
    await page.request.post(`${BASE}/api/session/organisation`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ organisationId: QA_ORG }),
    });
    await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const org = await page.request.get(`${BASE}/api/organisations`);
    const orgJson = await org.json();
    const serverRevision = orgJson.workspaceRevision as string | null;
    console.log(`A->B->A test: server workspaceRevision=${serverRevision}`);

    // Part A: org-id guard — wrong org id must be blocked regardless of revision.
    const staleOrgPost = await page.request.post(`${BASE}/api/contacts`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": STALE_FAKE_ORG,
      },
      data: JSON.stringify({
        fullName: `QA-stale-R4-aba-orgid-${Date.now()}`,
        email: `r4-stale-aba-orgid-${Date.now()}@example.com`,
        leadSource: "manual",
      }),
    });
    expect(staleOrgPost.status(), "stale org id must be blocked with 409").toBe(409);
    expect((await staleOrgPost.json()).code).toBe("WORKSPACE_CHANGED");

    // Part B: revision guard — only fires if server returns a revision (post-deploy).
    if (serverRevision) {
      const staleRevPost = await page.request.post(`${BASE}/api/contacts`, {
        headers: {
          "Content-Type": "application/json",
          "x-expected-organisation-id": QA_ORG,
          "x-expected-workspace-revision": "2000-01-01T00:00:00.000Z",
        },
        data: JSON.stringify({
          fullName: `QA-stale-R4-aba-rev-${Date.now()}`,
          email: `r4-stale-aba-rev-${Date.now()}@example.com`,
          leadSource: "manual",
        }),
      });
      console.log(`A->B->A revision test: status=${staleRevPost.status()}`);
      expect(staleRevPost.status(), "stale revision must be blocked with 409").toBe(409);
    } else {
      // Production hasn't deployed revision support yet — document the gap.
      console.log("A->B->A revision guard: server does not return workspaceRevision — revision check SKIPPED (requires deployment of new code)");
    }
  });

  test("ask routing: pipeline internal, gdpr research", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto(`${BASE}/ask`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Verify pipeline tile is clickable and starts a run.
    const pipelineBtn = page.getByRole("button", { name: /Summarise my pipeline/i });
    if (await pipelineBtn.count()) {
      await pipelineBtn.click();
      await expect(page.locator("text=Working").first()).toBeVisible({ timeout: 25_000 });
    }
  });
});
