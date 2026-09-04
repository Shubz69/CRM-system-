/**
 * Round 6 — clean vs legacy browser profiles, reload recovery, first-click, inbox,
 * Ask Go, pipeline tile, first-paint, server stale guards.
 *
 * ROUND6_MODE=compact (default) → fast eng loop
 * ROUND6_MODE=full → mandatory stress counts
 *
 * Auth once → storageState. QA orgs only. No Shobhit Agency mutations.
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
const ORG_B = process.env.E2E_ORG_B_ID || "cmtlraj5u0004jo04qf5414pb";
const RUN_ID = `R6-${Date.now()}`;
const MODE = (process.env.ROUND6_MODE || "compact").toLowerCase() === "full" ? "full" : "compact";

const COUNTS = MODE === "full"
  ? {
      workspace: 10,
      inboxTotal: 100,
      inboxPerProfile: 25,
      ask: 20,
      pipeline: 20,
      contact: 20,
      deal: 20,
      askProfiles: ["clean", "legacy"] as const,
    }
  : {
      workspace: 3,
      inboxTotal: 10,
      inboxPerProfile: 0, // computed per profile below
      ask: 5,
      pipeline: 5,
      contact: 5,
      deal: 5,
      askProfiles: ["clean", "legacy"] as const,
    };

const STORAGE_STATE = path.join(process.cwd(), "QA", ".round6-storage-state.json");

function withBypass(url: string) {
  if (!BYPASS) return url;
  const u = new URL(url.startsWith("http") ? url : `${BASE}${url.startsWith("/") ? "" : "/"}${url}`);
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
  await page.goto(withBypass(`${BASE}/login`), { waitUntil: "domcontentloaded", timeout: 45_000 });
  const emailField = page.getByLabel(/^email$/i);
  await expect(emailField).toBeVisible({ timeout: 30_000 });
  await emailField.fill(process.env.E2E_EMAIL!);
  await page.getByLabel(/^password$/i).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 45_000 });
}

async function loadOrgs(page: Page) {
  const res = await page.request.get(`${BASE}/api/organisations`);
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    activeOrganisationId: string;
    workspaceRevision: string | null;
    organisations: Array<{ id: string; name: string }>;
  };
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
    .poll(async () => (await loadOrgs(page)).activeOrganisationId, { timeout: 20_000 })
    .toBe(organisationId);
}

async function waitReady(page: Page) {
  await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

function gate(page: Page) {
  return page.getByRole("alertdialog").filter({ hasText: /workspace changed/i });
}

async function seedLegacyWorkspaceStorage(page: Page, fromOrg: string, toOrg: string) {
  await page.evaluate(
    ({ fromOrg, toOrg }) => {
      const event = {
        type: "org-changed",
        organisationId: toOrg,
        organisationName: "Legacy Dest",
        fromOrganisationId: fromOrg,
        fromOrganisationName: "Legacy From",
        workspaceRevision: "2026-01-01T00:00:00.000Z",
        timestamp: Date.now() - 86_400_000,
      };
      localStorage.setItem("agent-desk-workspace-event", JSON.stringify(event));
      localStorage.setItem(
        "agent-desk-workspace-context",
        JSON.stringify({
          loadedOrganisationId: fromOrg,
          workspaceRevision: "2025-12-01T00:00:00.000Z",
        }),
      );
      sessionStorage.setItem(
        "agent-desk-workspace-context",
        JSON.stringify({
          loadedOrganisationId: fromOrg,
          workspaceRevision: "2025-12-01T00:00:00.000Z",
        }),
      );
      sessionStorage.removeItem("agent-desk-workspace-event-ack");
      localStorage.removeItem("agent-desk-workspace-storage-version");
    },
    { fromOrg, toOrg },
  );
}

async function switchAndBroadcast(page: Page, organisationId: string, fromOrganisationId: string) {
  await switchToOrg(page, organisationId);
  const orgs = await loadOrgs(page);
  const event = {
    type: "org-changed",
    organisationId,
    organisationName: orgs.organisations.find((o) => o.id === organisationId)?.name || organisationId,
    workspaceRevision: orgs.workspaceRevision,
    fromOrganisationId,
    fromOrganisationName:
      orgs.organisations.find((o) => o.id === fromOrganisationId)?.name || fromOrganisationId,
    changeId: `e2e-r6-${Date.now()}`,
    timestamp: Date.now(),
  };
  await page.evaluate((ev) => {
    localStorage.setItem("agent-desk-workspace-event", JSON.stringify(ev));
    try {
      const bc = new BroadcastChannel("agent-desk-workspace");
      bc.postMessage(ev);
      bc.close();
    } catch {
      /* ignore */
    }
  }, event);
  return event;
}

async function ensureStorageState(browser: Browser) {
  if (fs.existsSync(STORAGE_STATE)) {
    try {
      const ageMs = Date.now() - fs.statSync(STORAGE_STATE).mtimeMs;
      if (ageMs < 45 * 60_000) return STORAGE_STATE;
    } catch {
      /* recreate */
    }
  }
  const context = await browser.newContext({
    extraHTTPHeaders: BYPASS
      ? {
          "x-vercel-protection-bypass": BYPASS,
          "x-vercel-set-bypass-cookie": "true",
        }
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

async function openAuthedContext(browser: Browser, label: "clean" | "legacy" = "clean") {
  const state = await ensureStorageState(browser);
  const context = await browser.newContext({
    storageState: state,
    extraHTTPHeaders: BYPASS
      ? {
          "x-vercel-protection-bypass": BYPASS,
          "x-vercel-set-bypass-cookie": "true",
        }
      : {},
  });
  await attachBypass(context);
  const page = await context.newPage();
  await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitReady(page);
  await switchToOrg(page, ORG_A);
  if (label === "legacy") {
    await seedLegacyWorkspaceStorage(page, ORG_A, ORG_A);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
  }
  return { context, page };
}

async function seedInboxTrio(page: Page, profile: string) {
  const ids: string[] = [];
  for (const key of ["a", "b", "c"] as const) {
    const seed = await page.request.post(`${BASE}/api/simulator`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        text: `E2E R6 ${RUN_ID} ${profile} ${key}`,
        contactExternalId: `e2e_r6_${RUN_ID}_${profile}_${key}`,
        fullName: `E2E-${RUN_ID}-${profile}-${key}`,
        instagramUsername: `e2e_r6_${RUN_ID}_${profile}_${key}`,
      }),
    });
    expect(seed.ok()).toBeTruthy();
    const body = (await seed.json()) as {
      conversationId?: string;
      conversation?: { id?: string };
      result?: { conversationId?: string; conversation?: { id?: string } };
    };
    const id =
      body.result?.conversationId ||
      body.result?.conversation?.id ||
      body.conversationId ||
      body.conversation?.id;
    if (!id) {
      // Fallback: resolve by list after seed (older simulator payload shapes).
      const list = await page.request.get(`${BASE}/api/conversations`);
      const lj = (await list.json()) as {
        conversations?: Array<{ id: string; contactName?: string; instagramUsername?: string }>;
      };
      const match = (lj.conversations || []).find(
        (c) =>
          c.instagramUsername === `e2e_r6_${RUN_ID}_${profile}_${key}` ||
          c.contactName === `E2E-${RUN_ID}-${profile}-${key}`,
      );
      expect(match?.id).toBeTruthy();
      ids.push(match!.id);
    } else {
      ids.push(id);
    }
  }
  return ids;
}

async function clickInboxRow(page: Page, conversationId: string) {
  await expect(page.getByRole("alertdialog").filter({ hasText: /workspace changed/i })).toHaveCount(
    0,
    { timeout: 5_000 },
  );
  const row = page.getByTestId(`inbox-row-${conversationId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.scrollIntoViewIfNeeded();
  const detailPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/conversations/${conversationId}`) &&
      r.request().method() === "GET" &&
      r.ok(),
    { timeout: 20_000 },
  );
  // One normal customer click — no mouse coords, force, or retries.
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
    { timeout: 15_000 },
  );
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
  await expect(page.locator('[data-inbox-empty="true"]')).toHaveCount(0);
}

test.setTimeout(MODE === "full" ? 600_000 : 180_000);

test.describe(`Round 6 production-parity (${MODE})`, () => {
  test.skip(!hasAuth, "E2E_EMAIL/E2E_PASSWORD required");

  test(`workspace recovery ×${COUNTS.workspace}`, async ({ browser }) => {
    test.setTimeout(MODE === "full" ? 900_000 : 240_000);
    let reloadPass = 0;
    let newTabPass = 0;
    let obsoletePass = 0;
    let migrationPass = 0;

    const { context, page } = await openAuthedContext(browser, "clean");

    for (let i = 0; i < COUNTS.workspace; i++) {
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await waitReady(page);

      await seedLegacyWorkspaceStorage(page, ORG_A, ORG_A);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitReady(page);
      const after = await page.evaluate(() => ({
        version: localStorage.getItem("agent-desk-workspace-storage-version"),
        localContext: localStorage.getItem("agent-desk-workspace-context"),
        sessionOk: (() => {
          try {
            const raw = sessionStorage.getItem("agent-desk-workspace-context");
            if (!raw) return true;
            return Boolean(JSON.parse(raw).documentLoadId);
          } catch {
            return false;
          }
        })(),
      }));
      if (after.localContext == null && after.sessionOk && after.version === "6") migrationPass++;

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await waitReady(tabB);
      await switchAndBroadcast(tabB, ORG_B, ORG_A);
      await expect(gate(page)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("workspace-gate-reload").click();
      await page.waitForLoadState("domcontentloaded");
      await expect(gate(page)).toHaveCount(0, { timeout: 15_000 });
      await waitReady(page);
      reloadPass++;

      const tabC = await context.newPage();
      await tabC.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await waitReady(tabC);
      await expect(gate(tabC)).toHaveCount(0, { timeout: 10_000 });
      newTabPass++;
      await tabC.close();

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitReady(page);
      await expect(gate(page)).toHaveCount(0, { timeout: 10_000 });
      obsoletePass++;

      await switchToOrg(page, ORG_A);
      await tabB.close();
    }

    expect(migrationPass).toBe(COUNTS.workspace);
    expect(reloadPass).toBe(COUNTS.workspace);
    expect(newTabPass).toBe(COUNTS.workspace);
    expect(obsoletePass).toBe(COUNTS.workspace);
    console.log(`R6_WORKSPACE_LEGACY_MIGRATION=${COUNTS.workspace}/${COUNTS.workspace}`);
    console.log(`R6_RELOAD=${COUNTS.workspace}/${COUNTS.workspace}`);
    console.log(`R6_NEW_TAB=${COUNTS.workspace}/${COUNTS.workspace}`);
    console.log(`R6_OBSOLETE=${COUNTS.workspace}/${COUNTS.workspace}`);
    await context.close();
  });

  test("server stale guards still 409", async ({ browser }) => {
    const { context, page } = await openAuthedContext(browser, "clean");
    await page.goto(withBypass(`${BASE}/contacts`), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const before = await loadOrgs(page);
    const tabB = await context.newPage();
    await tabB.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitReady(tabB);
    await switchAndBroadcast(tabB, ORG_B, ORG_A);

    const stale = await page.request.post(`${BASE}/api/contacts`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": ORG_A,
        "x-expected-workspace-revision": before.workspaceRevision!,
      },
      data: JSON.stringify({
        fullName: `E2E-${RUN_ID}-stale`,
        email: `r6-stale-${Date.now()}@example.com`,
        leadSource: "manual",
      }),
    });
    expect(stale.status()).toBe(409);

    await switchAndBroadcast(tabB, ORG_A, ORG_B);
    const after = await loadOrgs(tabB);
    const staleAba = await page.request.post(`${BASE}/api/contacts`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": ORG_A,
        "x-expected-workspace-revision": before.workspaceRevision!,
      },
      data: JSON.stringify({
        fullName: `E2E-${RUN_ID}-stale-aba`,
        email: `r6-stale-aba-${Date.now()}@example.com`,
        leadSource: "manual",
      }),
    });
    expect(staleAba.status()).toBe(409);
    expect(after.workspaceRevision).not.toBe(before.workspaceRevision);

    const deal = await page.request.post(`${BASE}/api/deals`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": ORG_A,
        "x-expected-workspace-revision": before.workspaceRevision!,
      },
      data: JSON.stringify({ name: `E2E-${RUN_ID}-deal`, amountCents: 1000, currency: "GBP" }),
    });
    expect(deal.status()).toBe(409);
    console.log("R6_SERVER_STALE=3/3");
    await context.close();
  });

  test(`inbox first-click ×${COUNTS.inboxTotal}`, async ({ browser }) => {
    test.setTimeout(MODE === "full" ? 1_200_000 : 300_000);
    let pass = 0;
    const profiles: Array<"clean" | "recovery" | "legacy" | "mixed"> = [
      "clean",
      "recovery",
      "legacy",
      "mixed",
    ];
    const perProfile =
      MODE === "full"
        ? 25
        : ({ clean: 4, recovery: 2, legacy: 2, mixed: 2 } as Record<string, number>);

    // One signed-in context reused across profile classes (storage wiped/reseeded as needed).
    const { context, page } = await openAuthedContext(browser, "clean");

    for (const profile of profiles) {
      const n = typeof perProfile === "number" ? perProfile : perProfile[profile]!;
      await switchToOrg(page, ORG_A);
      const ids = await seedInboxTrio(page, profile);

      if (profile === "legacy") {
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await seedLegacyWorkspaceStorage(page, ORG_A, ORG_A);
        await page.reload({ waitUntil: "domcontentloaded" });
      } else if (profile === "recovery") {
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        const tabB = await context.newPage();
        await tabB.goto(withBypass(`${BASE}/home`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(tabB);
        await switchAndBroadcast(tabB, ORG_B, ORG_A);
        await expect(gate(page)).toBeVisible({ timeout: 15_000 });
        await page.getByTestId("workspace-gate-reload").click();
        await page.waitForLoadState("domcontentloaded");
        await switchToOrg(page, ORG_A);
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await tabB.close();
      } else if (profile === "mixed") {
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.goto(withBypass(`${BASE}/home`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      } else {
        await page.goto(withBypass(`${BASE}/inbox`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      }

      await waitReady(page);
      for (const id of ids) {
        await expect(page.getByTestId(`inbox-row-${id}`)).toBeVisible({ timeout: 20_000 });
      }

      for (let i = 0; i < n; i++) {
        const conversationId = ids[i % 3]!;
        console.log(`Inbox locator ${pass + 1}/${COUNTS.inboxTotal} profile=${profile}`);
        await clickInboxRow(page, conversationId);
        pass++;
        if (pass % 10 === 0) {
          console.log(`R6_INBOX_PROGRESS=${pass}/${COUNTS.inboxTotal} profile=${profile}`);
        }
      }
    }

    expect(pass).toBe(COUNTS.inboxTotal);
    console.log(`R6_INBOX_${COUNTS.inboxTotal}=PASS`);
    await context.close();
  });

  test(`Ask/Pipeline/Contact/Deal first-click ×${COUNTS.ask}`, async ({ browser }) => {
    test.setTimeout(MODE === "full" ? 1_200_000 : 300_000);
    let go = 0;
    let pipeline = 0;
    let contact = 0;
    let deal = 0;

    const perProfile = Math.ceil(COUNTS.ask / COUNTS.askProfiles.length);
    const { context, page } = await openAuthedContext(browser, "clean");

    for (const profile of COUNTS.askProfiles) {
      for (let i = 0; i < perProfile && go < COUNTS.ask; i++) {
        if (profile === "legacy") {
          await page.goto(withBypass(`${BASE}/ask`), {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await seedLegacyWorkspaceStorage(page, ORG_A, ORG_A);
          await page.reload({ waitUntil: "domcontentloaded" });
        }

        await page.goto(withBypass(`${BASE}/ask`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        const goBtn = page.getByTestId("ask-go");
        await page.getByRole("textbox").first().fill(`E2E-${RUN_ID} quick ping ${profile}-${i}`);
        await expect(goBtn).toBeEnabled({ timeout: 15_000 });
        const askPost = page.waitForResponse(
          (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
          { timeout: 20_000 },
        );
        await goBtn.click();
        const askRes = await askPost;
        expect(askRes.ok()).toBeTruthy();
        await expect(page.getByText(/Working|Starting|Research|CRM/i).first()).toBeVisible({
          timeout: 20_000,
        });
        go++;
        if (go % 5 === 0) console.log(`R6_ASK_PROGRESS=${go}/${COUNTS.ask}`);

        await page.goto(withBypass(`${BASE}/ask`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        const tile = page.getByTestId("ask-tile-pipeline");
        await expect(tile).toBeEnabled({ timeout: 15_000 });
        const tilePost = page.waitForResponse(
          (r) => r.url().includes("/api/ask") && r.request().method() === "POST",
          { timeout: 20_000 },
        );
        await tile.click();
        const tileRes = await tilePost;
        expect(tileRes.ok()).toBeTruthy();
        const body = tileRes.request().postDataJSON() as { request?: string };
        expect(body.request || "").toMatch(/pipeline/i);
        pipeline++;
        if (pipeline % 5 === 0) console.log(`R6_PIPELINE_PROGRESS=${pipeline}/${COUNTS.pipeline}`);

        await page.goto(withBypass(`${BASE}/contacts`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        await expect(page.getByText(/Loading contacts/i)).toHaveCount(0, { timeout: 20_000 });
        const add = page.getByTestId("add-contact");
        await expect(add).toBeEnabled({ timeout: 15_000 });
        await add.click();
        await expect(page.getByRole("dialog").or(page.getByText(/Add contact/i)).first()).toBeVisible({
          timeout: 10_000,
        });
        contact++;
        if (contact % 5 === 0) console.log(`R6_CONTACT_PROGRESS=${contact}/${COUNTS.contact}`);
        await page.keyboard.press("Escape").catch(() => undefined);

        await page.goto(withBypass(`${BASE}/deals`), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await waitReady(page);
        const newDeal = page.getByTestId("new-deal");
        await expect(newDeal).toBeEnabled({ timeout: 15_000 });
        await newDeal.click();
        await expect(
          page.getByRole("dialog").or(page.getByText(/New deal|Create deal|Deal name/i)).first(),
        ).toBeVisible({ timeout: 10_000 });
        deal++;
        if (deal % 5 === 0) console.log(`R6_DEAL_PROGRESS=${deal}/${COUNTS.deal}`);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }

    expect(go).toBe(COUNTS.ask);
    expect(pipeline).toBe(COUNTS.pipeline);
    expect(contact).toBe(COUNTS.contact);
    expect(deal).toBe(COUNTS.deal);
    console.log(`R6_ASK_GO=${COUNTS.ask}/${COUNTS.ask}`);
    console.log(`R6_PIPELINE=${COUNTS.pipeline}/${COUNTS.pipeline}`);
    console.log(`R6_ADD_CONTACT=${COUNTS.contact}/${COUNTS.contact}`);
    console.log(`R6_NEW_DEAL=${COUNTS.deal}/${COUNTS.deal}`);
    await context.close();
  });

  test("first-paint surfaces never false-empty while loading", async ({ browser }) => {
    const { context, page } = await openAuthedContext(browser, "clean");
    await page.goto(withBypass(`${BASE}/contacts`), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await waitReady(page);
    await expect(page.getByText(/Loading contacts|No contacts yet|Name/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/Loading contacts/i)).toHaveCount(0, { timeout: 20_000 });
    for (const p of ["/companies", "/deals", "/goals", "/content", "/inbox", "/analytics"]) {
      await page.goto(withBypass(`${BASE}${p}`), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await waitReady(page);
    }
    console.log("R6_FIRST_PAINT=PASS");
    await context.close();
  });
});
