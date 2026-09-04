/**
 * Round 6 COMPACT only — Inbox×10, Ask Go×5, Pipeline×5.
 * Split tests share storageState. Live console progress. Fail-fast.
 */
import { config as loadEnv } from "dotenv";
import fs from "fs";
import path from "path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const ORG_A = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const RUN_ID = `R6C-${Date.now()}`;
const STORAGE_STATE = path.join(process.cwd(), "QA", ".round6-storage-state.json");

function withBypass(url: string) {
  if (!BYPASS) return url;
  const u = new URL(url.startsWith("http") ? url : `${BASE}${url}`);
  u.searchParams.set("x-vercel-protection-bypass", BYPASS);
  u.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return u.toString();
}

async function attachBypass(context: BrowserContext) {
  if (!BYPASS) return;
  await context.addCookies([
    {
      name: "x-vercel-protection-bypass",
      value: BYPASS,
      url: BASE,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function signIn(page: Page) {
  await page.goto(withBypass(`${BASE}/login`), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.getByLabel(/^email$/i)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel(/^email$/i).fill(process.env.E2E_EMAIL!);
  await page.getByLabel(/^password$/i).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
}

async function switchToOrg(page: Page, organisationId: string) {
  await page.evaluate(async (organisationId) => {
    await fetch("/api/session/organisation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationId }),
    });
    const csrf = await fetch("/api/auth/csrf").then((r) => r.json());
    await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrfToken: csrf.csrfToken, data: { organisationId } }),
    });
  }, organisationId);
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${BASE}/api/organisations`);
        const j = await r.json();
        return j.activeOrganisationId as string;
      },
      { timeout: 15_000 },
    )
    .toBe(organisationId);
}

async function waitReady(page: Page) {
  await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 20_000 });
}

async function ensureStorageState(browser: Browser) {
  if (fs.existsSync(STORAGE_STATE)) {
    const ageMs = Date.now() - fs.statSync(STORAGE_STATE).mtimeMs;
    if (ageMs < 45 * 60_000) return STORAGE_STATE;
  }
  const context = await browser.newContext({
    extraHTTPHeaders: BYPASS
      ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
      : {},
  });
  await attachBypass(context);
  const page = await context.newPage();
  await signIn(page);
  await switchToOrg(page, ORG_A);
  await context.storageState({ path: STORAGE_STATE });
  await context.close();
  return STORAGE_STATE;
}

async function openPage(browser: Browser) {
  const state = await ensureStorageState(browser);
  const context = await browser.newContext({
    storageState: state,
    extraHTTPHeaders: BYPASS
      ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
      : {},
  });
  await attachBypass(context);
  const page = await context.newPage();
  await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitReady(page);
  await switchToOrg(page, ORG_A);
  return { context, page };
}

async function seedTrio(page: Page) {
  const ids: string[] = [];
  for (const key of ["a", "b", "c"] as const) {
    const seed = await page.request.post(`${BASE}/api/simulator`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        text: `E2E compact ${RUN_ID} ${key}`,
        contactExternalId: `e2e_r6c_${RUN_ID}_${key}`,
        fullName: `E2E-C-${RUN_ID}-${key}`,
        instagramUsername: `e2e_r6c_${RUN_ID}_${key}`,
      }),
    });
    expect(seed.ok(), `simulator ${key}`).toBeTruthy();
    const body = await seed.json();
    let id =
      body?.result?.conversationId ||
      body?.result?.conversation?.id ||
      body?.conversationId ||
      body?.conversation?.id;
    if (!id) {
      const list = await page.request.get(`${BASE}/api/conversations`);
      const lj = await list.json();
      const match = (lj.conversations || []).find(
        (c: { id: string; contactName?: string; instagramUsername?: string }) =>
          c.instagramUsername === `e2e_r6c_${RUN_ID}_${key}` ||
          c.contactName === `E2E-C-${RUN_ID}-${key}`,
      );
      id = match?.id;
    }
    expect(id, `conversation id for ${key}`).toBeTruthy();
    ids.push(id);
  }
  return ids as [string, string, string];
}

async function selectInbox(page: Page, conversationId: string) {
  await expect(page.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toHaveCount(
    0,
    { timeout: 5_000 },
  );
  const row = page.getByTestId(`inbox-row-${conversationId}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.scrollIntoViewIfNeeded();

  const detailPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/conversations/${conversationId}`) && r.request().method() === "GET",
    { timeout: 15_000 },
  );
  // One normal customer click — no mouse coords, force, or retries.
  await row.click({ timeout: 10_000 });
  await expect(page.locator("[data-selected-conversation-id]")).toHaveAttribute(
    "data-selected-conversation-id",
    conversationId,
    { timeout: 8_000 },
  );
  const res = await detailPromise;
  expect(res.ok(), `detail GET ${conversationId}`).toBeTruthy();
  await expect(page.getByTestId("inbox-detail-header")).toHaveAttribute(
    "data-conversation-id",
    conversationId,
    { timeout: 12_000 },
  );
  await expect(page.locator('[data-inbox-empty="true"]')).toHaveCount(0);
  await expect(page.getByTestId("inbox-thread")).toHaveAttribute(
    "data-conversation-id",
    conversationId,
    { timeout: 8_000 },
  );
  await expect(page.getByTestId("inbox-compose")).toHaveAttribute(
    "data-conversation-id",
    conversationId,
    { timeout: 8_000 },
  );
  await expect(page.getByTestId("inbox-compose")).toHaveAttribute(
    "data-action-target",
    conversationId,
    { timeout: 8_000 },
  );
}

test.describe.configure({ mode: "serial" });

test.describe("Round 6 compact", () => {
  test.skip(!hasAuth, "E2E_EMAIL/E2E_PASSWORD required");

  test("Inbox ×10", async ({ browser }) => {
    test.setTimeout(150_000);
    const t0 = Date.now();
    const { context, page } = await openPage(browser);
    console.log(`R6C_AUTH_MS=${Date.now() - t0}`);
    let inboxPass = 0;
    const [a, b, c] = await seedTrio(page);
    await page.goto(withBypass(`${BASE}/inbox`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitReady(page);
    for (const id of [a, b, c]) {
      await expect(page.getByTestId(`inbox-row-${id}`)).toBeVisible({ timeout: 15_000 });
    }

    const beforeReload = [a, b, c, a, b, c, a];
    const afterReload = [b, c, a];
    for (let i = 0; i < beforeReload.length; i++) {
      const id = beforeReload[i]!;
      console.log(`R6C_INBOX_CLICK=${i + 1}/10 id=${id}`);
      await selectInbox(page, id);
      inboxPass++;
    }
    console.log("R6C_INBOX_RELOAD");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
    for (let i = 0; i < afterReload.length; i++) {
      const id = afterReload[i]!;
      console.log(`R6C_INBOX_CLICK=${beforeReload.length + i + 1}/10 id=${id}`);
      await selectInbox(page, id);
      inboxPass++;
    }
    console.log(`R6C_INBOX_PASS=${inboxPass}/10 RUNTIME_MS=${Date.now() - t0}`);
    expect(inboxPass).toBe(10);
    await context.close();
  });

  test("Ask Go ×5", async ({ browser }) => {
    test.setTimeout(120_000);
    const t0 = Date.now();
    const { context, page } = await openPage(browser);
    let askPass = 0;
    for (let i = 0; i < 5; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitReady(page);
      await expect(page.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toHaveCount(
        0,
      );
      const goBtn = page.getByTestId("ask-go");
      const box = page.getByRole("textbox").first();
      await box.fill(`E2E compact ping ${RUN_ID}-${i}`);
      await expect(goBtn).toBeEnabled({ timeout: 12_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      console.log(`R6C_ASK_CLICK=${i + 1}/5`);
      await goBtn.click({ timeout: 10_000 });
      const res = await post;
      expect(res.ok(), `ask POST ${i} status=${res.status()}`).toBeTruthy();
      askPass++;
      console.log(`R6C_ASK_OK=${askPass}`);
    }
    console.log(`R6C_ASK_PASS=${askPass}/5 RUNTIME_MS=${Date.now() - t0}`);
    expect(askPass).toBe(5);
    await context.close();
  });

  test("Pipeline tile ×5", async ({ browser }) => {
    test.setTimeout(120_000);
    const t0 = Date.now();
    const { context, page } = await openPage(browser);
    let pipePass = 0;
    for (let i = 0; i < 5; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitReady(page);
      const tile = page.getByTestId("ask-tile-pipeline");
      await expect(tile).toBeEnabled({ timeout: 12_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      console.log(`R6C_PIPELINE_CLICK=${i + 1}/5`);
      await tile.click({ timeout: 10_000 });
      const res = await post;
      expect(res.ok(), `pipeline POST ${i}`).toBeTruthy();
      const body = res.request().postDataJSON() as { request?: string };
      expect(body.request || "").toMatch(/pipeline/i);
      pipePass++;
      console.log(`R6C_PIPELINE_OK=${pipePass}`);
    }
    console.log(`R6C_PIPELINE_PASS=${pipePass}/5 RUNTIME_MS=${Date.now() - t0}`);
    expect(pipePass).toBe(5);
    await context.close();
  });
});
