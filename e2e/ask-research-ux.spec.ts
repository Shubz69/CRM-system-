/**
 * Browser coverage for Ask template cards + Research with Ask CTA.
 * Hosted: PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=https://…
 */
import { config as loadEnv } from "dotenv";
import { test, expect } from "@playwright/test";
import path from "path";
import { assertSafeQaTenantForMutationsOnPage } from "./helpers/tenant-safety";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (process.env.PLAYWRIGHT_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL || "",
  password: process.env.E2E_ADMIN_PASSWORD || "",
};

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="email"]').first().fill(ADMIN.email);
  await page.locator('input[type="password"]').first().fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
}

test.describe("Ask / Research UX wiring", () => {
  test.skip(!ADMIN.email || !ADMIN.password, "E2E_ADMIN_* required");
  test.setTimeout(120_000);

  test("Research a topic card prefills Ask input (not a silent no-op)", async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_SKIP_WEBSERVER !== "1", "hosted only");
    await signIn(page);
    await assertSafeQaTenantForMutationsOnPage(page, BASE);
    await page.goto(`${BASE}/ask`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Research a topic/i }).click();
    const input = page.locator("textarea, input[name='request']").first();
    await expect(input).toHaveValue(/Research/i, { timeout: 10_000 });
    await expect(page.getByText(/Add a topic|press Go/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Research with Ask posts /api/ask when topic set", async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_SKIP_WEBSERVER !== "1", "hosted only");
    await signIn(page);
    await assertSafeQaTenantForMutationsOnPage(page, BASE);
    await page.goto(`${BASE}/research`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Research topic/i).fill(`E2E-${Date.now()}-wiring-only`);
    const askPost = page.waitForRequest(
      (req) => req.url().includes("/api/ask") && req.method() === "POST",
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /Research with Ask/i }).click();
    const req = await askPost;
    expect(req).toBeTruthy();
  });
});
