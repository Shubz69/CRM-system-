import { expect, test, type Page } from "@playwright/test";

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const QA_ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const PLATFORM_ORG = process.env.E2E_PLATFORM_ORG_ID || "cmsrtrln1000aufyswjcwliz7";

async function loginIfNeeded(page: Page) {
  await page.goto("/login");
  if (await page.locator('input[type="email"]').count()) {
    await page.fill('input[type="email"]', process.env.E2E_EMAIL!);
    await page.fill('input[type="password"]', process.env.E2E_PASSWORD!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(home|ask|inbox)/, { timeout: 60_000 });
  }
}

test.describe("Round 4 closure checks", () => {
  test.skip(!hasAuth, "BLOCKED: E2E_EMAIL/E2E_PASSWORD are required");

  test("A->B stale contact mutation blocked with 409", async ({ page }) => {
    await loginIfNeeded(page);
    const org = await page.request.get("/api/organisations");
    const orgJson = await org.json();
    const revision = String(orgJson.workspaceRevision || "");

    await page.request.post("/api/session/organisation", { data: { organisationId: QA_ORG } });
    await page.request.post("/api/session/organisation", { data: { organisationId: PLATFORM_ORG } });

    const stale = await page.request.post("/api/contacts", {
      headers: {
        "x-expected-organisation-id": QA_ORG,
        "x-expected-workspace-revision": revision,
      },
      data: {
        fullName: `QA-stale-form-R4-${Date.now()}`,
        email: `r4-stale-${Date.now()}@example.com`,
      },
    });
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("WORKSPACE_CHANGED");
  });

  test("ask routing: pipeline internal, gdpr research", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/ask");
    await page.getByRole("button", { name: "Summarise my pipeline" }).click();
    await expect(page.locator("text=Working")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("What should Agent Desk do?").fill(
      "Research UK GDPR lawful basis requirements for marketing emails with sources",
    );
    await page.getByRole("button", { name: "Go" }).click();
    await expect(page.locator("text=Working")).toBeVisible({ timeout: 15_000 });
  });
});
