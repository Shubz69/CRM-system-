import { test, expect } from "@playwright/test";

/**
 * Focused Round 3 workspace + pipeline guards.
 * Requires E2E credentials for Automated QA — if auth is missing, mark BLOCKED (do not claim 0 as quality).
 */

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const QA_ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const PLATFORM_ORG = process.env.E2E_PLATFORM_ORG_ID || "cmsrtrln1000aufyswjcwliz7";

test.describe("Round 3 org switch + stale mutation", () => {
  test.skip(!hasAuth, "BLOCKED: E2E_EMAIL/E2E_PASSWORD not configured for Automated QA");

  test("POST organisation switch readback matches GET orgs and auth session", async ({
    page,
    request,
  }) => {
    // Login via app login page if present; otherwise rely on storage state.
    await page.goto("/login");
    if (await page.locator('input[type="email"]').count()) {
      await page.fill('input[type="email"]', process.env.E2E_EMAIL!);
      await page.fill('input[type="password"]', process.env.E2E_PASSWORD!);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/(home|ask|inbox)/, { timeout: 60_000 });
    }

    async function switchTo(organisationId: string) {
      const res = await page.request.post("/api/session/organisation", {
        data: { organisationId },
      });
      const json = await res.json();
      expect(res.status(), json.error || "switch").toBe(200);
      expect(json.verified).toBe(true);
      expect(json.organisationId).toBe(organisationId);
      expect(json.activeOrganisationId).toBe(organisationId);

      // Refresh client session cookie claims
      await page.evaluate(async (orgId) => {
        // next-auth client update is not available in page.evaluate without import —
        // reload after POST is the product path; for API verify we hit GET directly.
        void orgId;
      }, organisationId);

      // Force JWT refresh by loading a page that uses session
      await page.goto("/home");
      await page.waitForLoadState("networkidle");

      const orgs = await page.request.get("/api/organisations");
      const orgsJson = await orgs.json();
      expect(orgsJson.activeOrganisationId).toBe(organisationId);

      const session = await page.request.get("/api/auth/session");
      const sessionJson = await session.json();
      expect(sessionJson.user?.organisationId).toBe(organisationId);
    }

    // A→B→A→B→A across QA and Platform when membership allows.
    const targets = [QA_ORG, PLATFORM_ORG, QA_ORG, PLATFORM_ORG, QA_ORG];
    for (const orgId of targets) {
      await switchTo(orgId);
    }
  });

  test("stale expectedOrganisationId blocks contact create with 409", async ({ page }) => {
    await page.goto("/login");
    if (await page.locator('input[type="email"]').count()) {
      await page.fill('input[type="email"]', process.env.E2E_EMAIL!);
      await page.fill('input[type="password"]', process.env.E2E_PASSWORD!);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/(home|ask|inbox)/, { timeout: 60_000 });
    }

    await page.request.post("/api/session/organisation", {
      data: { organisationId: QA_ORG },
    });
    await page.goto("/home");

    const stale = await page.request.post("/api/contacts", {
      headers: { "x-expected-organisation-id": PLATFORM_ORG },
      data: {
        fullName: `QA-stale-form-${Date.now()}`,
        email: `stale-${Date.now()}@example.com`,
      },
    });
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("WORKSPACE_CHANGED");
  });
});
