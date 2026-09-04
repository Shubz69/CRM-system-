/**
 * Round 7B REGRESSION — Workspace 2/2, Inbox 3/3, Ask Go 2/2, Pipeline 2/2.
 * Proves Round 7 interaction fixes remain green after structured-extraction work.
 * Normal locator.click only. No retries, coordinates, or force.
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
const ORG_B = process.env.E2E_SECOND_ORG_ID || "";
const RUN_ID = `R7B-${Date.now()}`;
const STORAGE_CLEAN = path.join(process.cwd(), "QA", ".round7b-storage-clean.json");
const STORAGE_LONG = path.join(process.cwd(), "QA", ".round7b-storage-longlived.json");
const LEGACY_SEED = path.join(process.cwd(), "QA", ".round6-storage-state.json");

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
  await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 40_000 });
}

async function expectGateClear(page: Page) {
  await expect(page.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toHaveCount(
    0,
    { timeout: 10_000 },
  );
  await expect(page.locator('[data-workspace-gate="blocked"]')).toHaveCount(0, { timeout: 10_000 });
  const gate = await page.evaluate(() => document.documentElement.dataset.workspaceGate || "clear");
  expect(gate).toBe("clear");
}

async function broadcastSwitch(
  page: Page,
  organisationId: string,
  organisationName: string,
  workspaceRevision: string | null,
) {
  await page.evaluate(
    ({ organisationId, organisationName, workspaceRevision }) => {
      const changeId = `${organisationId}:${workspaceRevision || ""}:${Date.now()}`;
      const event = {
        type: "org-changed",
        organisationId,
        organisationName,
        workspaceRevision,
        changeId,
        eventId: changeId,
        timestamp: Date.now(),
      };
      localStorage.setItem("agent-desk-workspace-event", JSON.stringify(event));
      try {
        const bc = new BroadcastChannel("agent-desk-workspace");
        bc.postMessage(event);
        bc.close();
      } catch {
        /* ignore */
      }
    },
    { organisationId, organisationName, workspaceRevision },
  );
}

async function ensureCleanState(browser: Browser) {
  const context = await browser.newContext({
    extraHTTPHeaders: BYPASS
      ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
      : {},
  });
  await attachBypass(context);
  const page = await context.newPage();
  await signIn(page);
  await switchToOrg(page, ORG_A);
  await context.storageState({ path: STORAGE_CLEAN });
  await context.close();
  return STORAGE_CLEAN;
}

async function ensureLongLivedState(browser: Browser) {
  if (fs.existsSync(LEGACY_SEED)) {
    // Migrate/seed from prior long-lived Round 6 profile, then refresh session.
    const context = await browser.newContext({
      storageState: LEGACY_SEED,
      extraHTTPHeaders: BYPASS
        ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
        : {},
    });
    await attachBypass(context);
    const page = await context.newPage();
    await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (page.url().includes("/login")) {
      await signIn(page);
    }
    await waitReady(page);
    await switchToOrg(page, ORG_A);
    // Inject legacy keys that migration must clear/normalize.
    await page.evaluate(() => {
      try {
        localStorage.setItem(
          "agent-desk-workspace-context",
          JSON.stringify({ loadedOrganisationId: "legacy-poison", workspaceRevision: "old" }),
        );
        localStorage.setItem("agent-desk-workspace-storage-version", "4");
      } catch {
        /* ignore */
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
    await context.storageState({ path: STORAGE_LONG });
    await context.close();
    return STORAGE_LONG;
  }
  return ensureCleanState(browser);
}

async function openWithState(browser: Browser, statePath: string) {
  const context = await browser.newContext({
    storageState: statePath,
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
        text: `E2E r7 ${RUN_ID} ${key}`,
        contactExternalId: `e2e_r7c_${RUN_ID}_${key}`,
        fullName: `E2E-R7-${RUN_ID}-${key}`,
        instagramUsername: `e2e_r7c_${RUN_ID}_${key}`,
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
          c.instagramUsername === `e2e_r7c_${RUN_ID}_${key}` ||
          c.contactName === `E2E-R7-${RUN_ID}-${key}`,
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
      r.url().includes(`/api/conversations/${conversationId}`) &&
      r.request().method() === "GET" &&
      r.ok(),
    { timeout: 15_000 },
  );
  await row.click({ timeout: 10_000 });
  await expect(page.locator("[data-selected-conversation-id]")).toHaveAttribute(
    "data-selected-conversation-id",
    conversationId,
    { timeout: 8_000 },
  );
  await detailPromise;
  await expect(page.getByTestId("inbox-detail-header")).toHaveAttribute(
    "data-conversation-id",
    conversationId,
    { timeout: 12_000 },
  );
}

async function resolveOrgB(page: Page): Promise<string | null> {
  if (ORG_B) return ORG_B;
  const r = await page.request.get(`${BASE}/api/organisations`);
  const j = await r.json();
  const other = (j.organisations || []).find(
    (o: { id: string; name?: string; demoData?: boolean }) =>
      o.id !== ORG_A && /qa|automated|workspace safety|platform/i.test(o.name || ""),
  );
  return other?.id || null;
}

test.describe.configure({ mode: "serial" });

test.describe("Round 7B regression", () => {
  test.skip(!hasAuth, "E2E_EMAIL/E2E_PASSWORD required");

  test("Workspace recovery 2/2", async ({ browser }) => {
    test.setTimeout(240_000);
    let pass = 0;
    for (let i = 0; i < 2; i++) {
      console.log(`R7B_WS_RECOVERY=${i + 1}/2`);
      const clean = await ensureCleanState(browser);
      const { context, page: tabA } = await openWithState(browser, clean);
      const orgB = await resolveOrgB(tabA);
      test.skip(!orgB, "Need a second QA org for workspace recovery");

      await tabA.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitReady(tabA);
      await switchToOrg(tabA, ORG_A);

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitReady(tabB);

      const switchRes = await tabB.evaluate(async (organisationId) => {
        const res = await fetch("/api/session/organisation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organisationId }),
        });
        return res.json();
      }, orgB!);
      await broadcastSwitch(
        tabB,
        orgB!,
        switchRes.organisationName || "B",
        typeof switchRes.workspaceRevision === "string" ? switchRes.workspaceRevision : null,
      );

      await expect(tabA.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toBeVisible({
        timeout: 15_000,
      });
      await expect(tabA.locator('[data-workspace-gate="blocked"]')).toHaveCount(1);

      await switchToOrg(tabA, orgB!);
      await tabA.getByTestId("workspace-gate-reload").click();
      await tabA.waitForLoadState("domcontentloaded");
      await waitReady(tabA);
      await expectGateClear(tabA);

      const orgs = await tabA.request.get(`${BASE}/api/organisations`).then((r) => r.json());
      expect(orgs.activeOrganisationId).toBe(orgB);

      pass++;
      console.log(`R7B_WS_OK=${pass}`);
      await context.close();
    }
    console.log(`R7B_WORKSPACE_PASS=${pass}/2`);
    expect(pass).toBe(2);
  });

  test("Inbox 3/3 clean profile", async ({ browser }) => {
    test.setTimeout(120_000);
    const clean = await ensureCleanState(browser);
    const { context, page } = await openWithState(browser, clean);
    const [a, b, c] = await seedTrio(page);
    await page.goto(withBypass(`${BASE}/inbox`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitReady(page);
    let pass = 0;
    for (const id of [a, b, c]) {
      console.log(`R7B_INBOX_CLEAN=${pass + 1}/3 id=${id}`);
      await selectInbox(page, id);
      pass++;
    }
    console.log(`R7B_INBOX_CLEAN_PASS=${pass}/3`);
    expect(pass).toBe(3);
    await context.close();
  });

  test("Ask Go 2/2 + Pipeline tile 2/2 clean", async ({ browser }) => {
    test.setTimeout(120_000);
    const clean = await ensureCleanState(browser);
    const { context, page } = await openWithState(browser, clean);
    let askPass = 0;
    for (let i = 0; i < 2; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitReady(page);
      const goBtn = page.getByTestId("ask-go");
      await page.getByRole("textbox").first().fill(`E2E r7b ask ${RUN_ID}-${i}`);
      await expect(goBtn).toBeEnabled({ timeout: 12_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      console.log(`R7B_ASK=${i + 1}/2`);
      await goBtn.click({ timeout: 10_000 });
      expect((await post).ok()).toBeTruthy();
      askPass++;
    }
    let pipePass = 0;
    for (let i = 0; i < 2; i++) {
      await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitReady(page);
      const tile = page.getByTestId("ask-tile-pipeline");
      await expect(tile).toBeEnabled({ timeout: 12_000 });
      const post = page.waitForResponse(
        (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      console.log(`R7B_PIPE=${i + 1}/2`);
      await tile.click({ timeout: 10_000 });
      expect((await post).ok()).toBeTruthy();
      pipePass++;
    }
    console.log(`R7B_ASK_PASS=${askPass}/2 R7B_PIPE_PASS=${pipePass}/2`);
    expect(askPass).toBe(2);
    expect(pipePass).toBe(2);
    await context.close();
  });

  test("Long-lived profile Inbox+Ask+Pipeline", async ({ browser }) => {
    test.setTimeout(120_000);
    const long = await ensureLongLivedState(browser);
    const { context, page } = await openWithState(browser, long);
    await expect(page.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toHaveCount(
      0,
    );
    const [a, b] = await seedTrio(page);
    await page.goto(withBypass(`${BASE}/inbox`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitReady(page);
    await selectInbox(page, a);
    await selectInbox(page, b);
    await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitReady(page);
    const goBtn = page.getByTestId("ask-go");
    await page.getByRole("textbox").first().fill(`E2E r7b longlived ${RUN_ID}`);
    await expect(goBtn).toBeEnabled({ timeout: 12_000 });
    const askPost = page.waitForResponse(
      (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
      { timeout: 20_000 },
    );
    await goBtn.click({ timeout: 10_000 });
    expect((await askPost).ok()).toBeTruthy();
    await page.goto(withBypass(`${BASE}/ask`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitReady(page);
    const tile = page.getByTestId("ask-tile-pipeline");
    const pipePost = page.waitForResponse(
      (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
      { timeout: 20_000 },
    );
    await tile.click({ timeout: 10_000 });
    expect((await pipePost).ok()).toBeTruthy();
    console.log("R7B_LONG_LIVED_PROFILE=PASS");
    await context.close();
  });
});
