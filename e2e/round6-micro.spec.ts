/**
 * Round 6 MICRO — tiny fail-fast probes only. Reuses QA/.round6-storage-state.json.
 */
import { config as loadEnv } from "dotenv";
import fs from "fs";
import path from "path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const ORG_A = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const RUN_ID = `R6M-${Date.now()}`;
const STORAGE = path.join(process.cwd(), "QA", ".round6-storage-state.json");
const MODE = process.env.R6_MICRO || "inbox"; // inbox | ask | pipeline

function withBypass(url: string) {
  if (!BYPASS) return url;
  const u = new URL(url);
  u.searchParams.set("x-vercel-protection-bypass", BYPASS);
  u.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return u.toString();
}

async function open(browser: Browser) {
  if (!fs.existsSync(STORAGE)) throw new Error("missing QA/.round6-storage-state.json — run compact auth first");
  const context = await browser.newContext({
    storageState: STORAGE,
    extraHTTPHeaders: BYPASS
      ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
      : {},
  });
  if (BYPASS) {
    await context.addCookies([
      { name: "x-vercel-protection-bypass", value: BYPASS, url: BASE, secure: true, sameSite: "Lax" },
    ]);
  }
  const page = await context.newPage();
  await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 25_000 });
  await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(async (organisationId) => {
    await fetch("/api/session/organisation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationId }),
    });
  }, ORG_A);
  return { context, page };
}

test.setTimeout(90_000);

test(`micro-${MODE}`, async ({ browser }) => {
  test.skip(!process.env.E2E_EMAIL, "auth required");
  const t0 = Date.now();
  console.log(`R6M_START mode=${MODE}`);
  const { context, page } = await open(browser);
  console.log(`R6M_AUTH_MS=${Date.now() - t0}`);

  if (MODE === "inbox") {
    const ids: string[] = [];
    for (const key of ["a", "b", "c"] as const) {
      const seed = await page.request.post(`${BASE}/api/simulator`, {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({
          text: `micro ${RUN_ID} ${key}`,
          contactExternalId: `e2e_r6m_${RUN_ID}_${key}`,
          fullName: `E2E-M-${RUN_ID}-${key}`,
          instagramUsername: `e2e_r6m_${RUN_ID}_${key}`,
        }),
      });
      expect(seed.ok()).toBeTruthy();
      const body = await seed.json();
      const id = body?.result?.conversationId || body?.result?.conversation?.id;
      expect(id).toBeTruthy();
      ids.push(id);
      console.log(`R6M_SEED=${key}`);
    }
    await page.goto(withBypass(`${BASE}/inbox`), { waitUntil: "domcontentloaded", timeout: 25_000 });
    await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 20_000 });
    for (let i = 0; i < 3; i++) {
      const id = ids[i]!;
      console.log(`R6M_INBOX_CLICK=${i + 1}/3`);
      const row = page.getByTestId(`inbox-row-${id}`);
      await expect(row).toBeVisible({ timeout: 12_000 });
      await row.scrollIntoViewIfNeeded();
      const wait = page.waitForResponse(
        (r) => r.url().includes(`/api/conversations/${id}`) && r.request().method() === "GET",
        { timeout: 12_000 },
      );
      await row.click({ timeout: 10_000 });
      await expect(page.locator("[data-selected-conversation-id]")).toHaveAttribute(
        "data-selected-conversation-id",
        id,
        { timeout: 8_000 },
      );
      expect((await wait).ok()).toBeTruthy();
      await expect(page.getByTestId("inbox-detail-header")).toHaveAttribute(
        "data-conversation-id",
        id,
        { timeout: 10_000 },
      );
      console.log(`R6M_INBOX_OK=${i + 1}`);
    }
    console.log("R6M_INBOX_3_PASS=YES");
  } else if (MODE === "ask") {
    for (let i = 0; i < 2; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 25_000 });
      await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 20_000 });
      console.log(`R6M_ASK_CLICK=${i + 1}/2`);
      await page.getByRole("textbox").first().fill(`micro ask ${RUN_ID}-${i}`);
      const go = page.getByTestId("ask-go");
      await expect(go).toBeEnabled({ timeout: 10_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 15_000 },
      );
      await go.click({ timeout: 8_000 });
      expect((await post).ok()).toBeTruthy();
      console.log(`R6M_ASK_OK=${i + 1}`);
    }
    console.log("R6M_ASK_GO_2_PASS=YES");
  } else {
    for (let i = 0; i < 2; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 25_000 });
      await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 20_000 });
      console.log(`R6M_PIPELINE_CLICK=${i + 1}/2`);
      const tile = page.getByTestId("ask-tile-pipeline");
      await expect(tile).toBeEnabled({ timeout: 10_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 15_000 },
      );
      await tile.click({ timeout: 8_000 });
      const res = await post;
      expect(res.ok()).toBeTruthy();
      const body = res.request().postDataJSON() as { request?: string };
      expect(body.request || "").toMatch(/pipeline/i);
      console.log(`R6M_PIPELINE_OK=${i + 1}`);
    }
    console.log("R6M_PIPELINE_2_PASS=YES");
  }

  console.log(`R6M_DONE_MS=${Date.now() - t0}`);
  await context.close();
});
