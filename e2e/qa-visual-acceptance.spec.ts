/**
 * One-off authenticated visual QA screenshot tour.
 * Usage: npx playwright test scripts/qa-visual-acceptance.spec.ts --config=playwright.config.ts
 * Or: npx playwright test --project=chromium scripts/qa-visual-acceptance.spec.ts
 */
import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL || "";
const PASSWORD = process.env.E2E_PASSWORD || "";
const OUT = path.join(process.cwd(), "QA", "screenshots");

if (!EMAIL || !PASSWORD) {
  throw new Error("E2E_EMAIL and E2E_PASSWORD are required (no hardcoded QA credentials)");
}

const DESKTOP_PAGES: Array<{ name: string; path: string }> = [
  { name: "home", path: "/home" },
  { name: "ask", path: "/ask" },
  { name: "inbox", path: "/inbox" },
  { name: "crm", path: "/crm" },
  { name: "pipeline", path: "/pipeline" },
  { name: "contacts", path: "/contacts" },
  { name: "companies", path: "/companies" },
  { name: "deals", path: "/deals" },
  { name: "growth", path: "/growth" },
  { name: "opportunities", path: "/opportunities" },
  { name: "research", path: "/research" },
  { name: "social-intelligence", path: "/social-intelligence" },
  { name: "content", path: "/content" },
  { name: "goals", path: "/goals" },
  { name: "business-profile", path: "/business-context" },
  { name: "knowledge", path: "/knowledge" },
  { name: "automations", path: "/automations" },
  { name: "analytics", path: "/analytics" },
  { name: "integrations", path: "/integrations" },
  { name: "settings", path: "/settings" },
  { name: "admin", path: "/admin" },
  { name: "learning", path: "/learning" },
];

test.describe("Frontend visual acceptance", () => {
  test.setTimeout(180_000);

  test("desktop + mobile screenshots", async ({ browser }) => {
    fs.mkdirSync(OUT, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });

    const ratings: Record<string, string> = {};
    for (const item of DESKTOP_PAGES) {
      const response = await page.goto(`${BASE}${item.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      const status = response?.status() ?? 0;
      const bodyText = await page.locator("body").innerText();
      const hasCrash = /Application error|Unhandled Runtime Error|Something went wrong/i.test(bodyText);
      ratings[item.name] =
        hasCrash || status >= 500 ? "FAIL" : status >= 400 ? "NEEDS_FIX" : "GOOD";
      await page.screenshot({
        path: path.join(OUT, `desktop-${item.name}.png`),
        fullPage: true,
      });
    }

    // Command palette
    await page.goto(`${BASE}/home`);
    await page.keyboard.press("Control+K");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "desktop-command-palette.png") });
    await page.keyboard.press("Escape");

    // Mobile
    await page.setViewportSize({ width: 390, height: 844 });
    for (const item of [
      { name: "home", path: "/home" },
      { name: "inbox", path: "/inbox" },
      { name: "crm", path: "/crm" },
    ]) {
      await page.goto(`${BASE}${item.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(OUT, `mobile-${item.name}.png`),
        fullPage: true,
      });
    }

    // Tablet inbox
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, "tablet-inbox.png"), fullPage: true });

    fs.writeFileSync(path.join(OUT, "ratings.json"), JSON.stringify(ratings, null, 2));
    expect(Object.values(ratings).every((r) => r !== "FAIL")).toBeTruthy();
    await context.close();
  });
});
