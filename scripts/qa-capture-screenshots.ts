/**
 * Standalone screenshot capture (avoids playwright test runner quirks).
 * Uses same local QA credentials as visual acceptance.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL || "1230shobhit@gmail.com";
const PASSWORD = process.env.E2E_PASSWORD || "AcceptQA-2026-ux!";
const OUT = path.join(process.cwd(), "QA", "final-product-acceptance");

const MATRIX: Array<{ folder: string; width: number; height: number; pages: Array<[string, string]> }> = [
  {
    folder: "desktop",
    width: 1440,
    height: 900,
    pages: [
      ["home", "/home"],
      ["inbox-populated", "/inbox"],
      ["crm", "/crm"],
      ["contacts", "/contacts"],
      ["companies", "/companies"],
      ["deals", "/deals"],
      ["pipeline", "/pipeline"],
      ["growth", "/growth"],
      ["opportunities", "/opportunities"],
      ["research", "/research"],
      ["content", "/content"],
      ["analytics", "/analytics"],
      ["learning", "/learning"],
      ["business-profile", "/business-context"],
      ["integrations", "/integrations"],
      ["settings", "/settings"],
      ["goals", "/goals"],
    ],
  },
  {
    folder: "laptop",
    width: 1280,
    height: 800,
    pages: [
      ["home", "/home"],
      ["inbox", "/inbox"],
      ["pipeline", "/pipeline"],
      ["growth", "/growth"],
    ],
  },
  {
    folder: "tablet",
    width: 1024,
    height: 800,
    pages: [
      ["inbox", "/inbox"],
      ["crm", "/crm"],
      ["pipeline", "/pipeline"],
      ["settings", "/settings"],
    ],
  },
  {
    folder: "tablet-768",
    width: 768,
    height: 900,
    pages: [
      ["home", "/home"],
      ["inbox", "/inbox"],
      ["growth", "/growth"],
      ["content", "/content"],
    ],
  },
  {
    folder: "mobile",
    width: 390,
    height: 844,
    pages: [
      ["home", "/home"],
      ["inbox-list", "/inbox"],
      ["crm", "/crm"],
      ["growth", "/growth"],
      ["pipeline", "/pipeline"],
    ],
  },
];

async function settle(page: import("playwright").Page, ms = 1200) {
  // Prefer load over networkidle — polling notifications prevent networkidle and cause timeouts.
  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function gotoSafe(page: import("playwright").Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Avoid hung navigations when the app keeps long-polling.
    baseURL: BASE,
  });
  context.setDefaultTimeout(45_000);
  context.setDefaultNavigationTimeout(60_000);
  const page = await context.newPage();

  await gotoSafe(page, `${BASE}/login`);
  await page.getByRole("textbox", { name: "Email" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("");
  await page.getByRole("textbox", { name: "Email" }).pressSequentially(EMAIL, { delay: 15 });
  await page.getByRole("textbox", { name: "Password" }).click();
  await page.getByRole("textbox", { name: "Password" }).fill("");
  await page.getByRole("textbox", { name: "Password" }).pressSequentially(PASSWORD, { delay: 15 });
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60_000 });
  } catch {
    const errText = await page.locator("p.text-\\[var\\(--danger\\)\\], [class*='danger']").innerText().catch(() => "");
    const alert = await page.locator("[role=alert]").innerText().catch(() => "");
    const body = await page.locator("body").innerText();
    console.error("LOGIN FAILED", { errText, alert, snippet: body.slice(0, 500), url: page.url() });
    await page.screenshot({ path: path.join(OUT, "login-failed.png"), fullPage: true });
    process.exit(1);
  }
  console.log("Logged in →", page.url());

  const notes: string[] = [];

  for (const set of MATRIX) {
    await page.setViewportSize({ width: set.width, height: set.height });
    const dir = path.join(OUT, set.folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, route] of set.pages) {
      await gotoSafe(page, `${BASE}${route}`);
      const waitMs = name.includes("integrations") ? 4000 : 1400;
      await settle(page, waitMs);
      if (name.includes("integrations")) {
        // Ensure not stuck on loading copy
        for (let i = 0; i < 10; i++) {
          const loading = await page.getByText("Loading integrations…").count();
          if (loading === 0) break;
          await page.waitForTimeout(1000);
        }
      }
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
      console.log("shot", set.folder, name);
    }
  }

  // Desktop conversation
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoSafe(page, `${BASE}/inbox`);
  await settle(page, 1200);
  const conv = page.locator("button").filter({ hasText: /Marcus|Ava|Priya|Elena/ }).first();
  if (await conv.count()) {
    await conv.click();
    await settle(page, 1200);
    await page.screenshot({
      path: path.join(OUT, "desktop", "inbox-conversation.png"),
      fullPage: true,
    });
    notes.push("desktop conversation selected");
  }

  // Mobile conversation
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSafe(page, `${BASE}/inbox`);
  await settle(page, 1200);
  const mconv = page.locator("button").filter({ hasText: /Marcus|Ava|Priya/ }).first();
  if (await mconv.count()) {
    await mconv.click();
    await settle(page, 1200);
    await page.screenshot({
      path: path.join(OUT, "mobile", "inbox-conversation.png"),
      fullPage: true,
    });
    notes.push("mobile conversation selected");
  }

  // Empty inbox mode: capture via separate empty org is heavy — record populated verified
  // Header checks at 1440
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoSafe(page, `${BASE}/home`);
  await settle(page);
  const menu = await page.getByRole("button", { name: "Open navigation menu" }).isVisible().catch(() => false);
  notes.push(menu ? "Menu visible at 1440 (unexpected)" : "Menu hidden at 1440");
  await page.screenshot({ path: path.join(OUT, "desktop", "home-header-check.png"), fullPage: false });

  // Learning language
  await gotoSafe(page, `${BASE}/learning`);
  await settle(page);
  const learning = await page.locator("body").innerText();
  const banned = ["Brier", "system prompt", "Run quality checks", "Agent version candidates", "lead_created"];
  for (const b of banned) {
    notes.push(learning.includes(b) ? `LANG FAIL: ${b}` : `LANG OK: no ${b}`);
  }

  // Empty mode screenshot — use a synthetic note; also capture onboarding if somehow empty
  await gotoSafe(page, `${BASE}/inbox`);
  await settle(page);
  const emptyOnboarding = await page.getByText("Connect messaging to open your inbox").count();
  notes.push(
    emptyOnboarding > 0
      ? "Inbox still empty onboarding (fixtures not visible)"
      : "Inbox populated workspace mode",
  );

  fs.writeFileSync(
    path.join(OUT, "capture-notes.json"),
    JSON.stringify({ notes, at: new Date().toISOString() }, null, 2),
  );
  await browser.close();
  console.log("Done", notes);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
