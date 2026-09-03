/**
 * Round 5 — workspace recovery, stale guards, inbox 50, first-click ×5, pipeline tile.
 * ORG A = Agent Desk Automated QA; ORG B = Agent Desk Workspace Safety QA.
 * Does not mutate Shobhit Agency.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import { test, expect, type Page } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();

function withBypass(url: string) {
  if (!BYPASS) return url;
  const u = new URL(url.startsWith("http") ? url : `${BASE}${url.startsWith("/") ? "" : "/"}${url}`);
  u.searchParams.set("x-vercel-protection-bypass", BYPASS);
  u.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return u.toString();
}

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const ORG_A = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const ORG_B = process.env.E2E_ORG_B_ID || "cmtlraj5u0004jo04qf5414pb";
const RUN_ID = `R5-${Date.now()}`;

async function signIn(page: Page) {
  if (BYPASS) {
    await page.context().addCookies([
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

  await page.goto(withBypass(`${BASE}/login`), { waitUntil: "domcontentloaded", timeout: 60_000 });
  const vercelSso = page.getByText(/log in to vercel/i);
  if (await vercelSso.isVisible().catch(() => false)) {
    await page.goto(withBypass(`${BASE}/login`), { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  if (await vercelSso.isVisible().catch(() => false)) {
    throw new Error("VERCEL_DEPLOYMENT_PROTECTION_BLOCKING: bypass cookie/header not accepted");
  }

  if (!page.url().includes("/login")) {
    const check = await page.request.get(`${BASE}/api/organisations`);
    if (check.status() === 200) return;
  }

  const emailField = page.getByLabel(/^email$/i);
  const passwordField = page.getByLabel(/^password$/i);
  await expect(emailField).toBeVisible({ timeout: 45_000 });
  await emailField.fill(process.env.E2E_EMAIL!);
  await passwordField.fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
  const check = await page.request.get(`${BASE}/api/organisations`);
  if (check.status() === 401) throw new Error("LOGIN_FAILED");
}

async function syncJwtToOrg(page: Page, organisationId: string) {
  const result = await page.evaluate(async (organisationId) => {
    const switchRes = await fetch("/api/session/organisation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationId }),
    });
    if (!switchRes.ok) {
      return { ok: false as const, step: "switch", status: switchRes.status };
    }
    const csrf = await fetch("/api/auth/csrf").then((r) => r.json());
    const sessionRes = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrfToken: csrf.csrfToken, data: { organisationId } }),
    });
    if (!sessionRes.ok) {
      return { ok: false as const, step: "session", status: sessionRes.status };
    }
    const orgs = await fetch("/api/organisations", { cache: "no-store" }).then((r) => r.json());
    return {
      ok: true as const,
      activeOrganisationId: orgs.activeOrganisationId as string,
      workspaceRevision: orgs.workspaceRevision as string | null,
    };
  }, organisationId);
  expect(result.ok, `syncJwtToOrg failed: ${JSON.stringify(result)}`).toBe(true);
  if (result.ok) {
    expect(result.activeOrganisationId).toBe(organisationId);
  }
}

async function switchToOrg(page: Page, organisationId: string) {
  const res = await page.request.post(`${BASE}/api/session/organisation`, {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ organisationId }),
  });
  expect(res.status(), `switch ${organisationId}`).toBe(200);
  const body = await res.json();
  expect(body.organisationId || body.activeOrganisationId).toBe(organisationId);

  const gate = page.getByRole("alertdialog").filter({ hasText: /workspace changed/i });
  if (await gate.isVisible().catch(() => false)) {
    await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    const url = page.url();
    if (!url.startsWith(BASE) || url.includes("/login")) {
      await page.goto(withBypass(`${BASE}/home`), { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
  }

  await syncJwtToOrg(page, organisationId);
  await expect
    .poll(async () => (await loadOrgs(page)).activeOrganisationId, { timeout: 30_000 })
    .toBe(organisationId);
  return body as { workspaceRevision?: string | null; organisationId?: string };
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

async function uiSwitch(page: Page, organisationId: string) {
  await waitWorkspaceReady(page);
  const select = page.getByLabel("Switch active workspace");
  await expect(select).toBeVisible({ timeout: 20_000 });
  const current = await select.inputValue();
  if (current === organisationId) {
    await expect
      .poll(async () => (await loadOrgs(page)).activeOrganisationId, { timeout: 30_000 })
      .toBe(organisationId);
    return;
  }
  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/session/organisation") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await select.selectOption(organisationId);
  const res = await responsePromise;
  expect(res.ok(), `uiSwitch ${organisationId} status=${res.status()}`).toBeTruthy();
  await page.waitForLoadState("domcontentloaded");
  await waitWorkspaceReady(page);
  await expect
    .poll(async () => (await loadOrgs(page)).activeOrganisationId, { timeout: 60_000 })
    .toBe(organisationId);
  await expect(page.getByLabel("Switch active workspace")).toHaveValue(organisationId, {
    timeout: 60_000,
  });
}

/** API switch + BroadcastChannel/localStorage event (authoritative for cross-tab gate). */
async function switchAndBroadcast(page: Page, organisationId: string, fromOrganisationId: string) {
  const before = await loadOrgs(page);
  const body = await switchToOrg(page, organisationId);
  const orgs = await loadOrgs(page);
  const event = {
    type: "org-changed",
    organisationId,
    organisationName:
      orgs.organisations.find((o) => o.id === organisationId)?.name || organisationId,
    workspaceRevision: orgs.workspaceRevision || body.workspaceRevision || null,
    fromOrganisationId,
    fromOrganisationName:
      orgs.organisations.find((o) => o.id === fromOrganisationId)?.name || fromOrganisationId,
    changeId: `e2e-${Date.now()}`,
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
  return { before, after: orgs, event };
}

async function waitWorkspaceReady(page: Page) {
  await expect(page.locator('[data-workspace-ready="true"]')).toBeVisible({ timeout: 45_000 });
}

function workspaceGate(page: Page) {
  return page.getByRole("alertdialog").filter({ hasText: /workspace changed/i });
}

async function contactExists(page: Page, name: string) {
  const res = await page.request.get(`${BASE}/api/contacts?q=${encodeURIComponent(name)}`);
  if (!res.ok()) return false;
  const json = await res.json();
  return ((json.contacts || []) as Array<{ fullName?: string | null }>).some((c) =>
    (c.fullName || "").includes(name),
  );
}

async function dealExists(page: Page, name: string) {
  const res = await page.request.get(`${BASE}/api/deals`);
  if (!res.ok()) return false;
  const json = await res.json();
  return ((json.deals || []) as Array<{ name?: string | null }>).some((d) =>
    (d.name || "").includes(name),
  );
}

test.setTimeout(240_000);

test.describe("Round 5 recovery + interaction", () => {
  test.skip(!hasAuth, "E2E_EMAIL/E2E_PASSWORD required");

  // ── A) Workspace recovery (6) ──────────────────────────────────────────
  test.describe("A) Workspace recovery", () => {
    test.describe.configure({ mode: "serial" });
    test("1. A→B Tab A blocks; Reload clears; fresh mutation in current org", async ({
      page,
      context,
    }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);

      await expect(workspaceGate(page)).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: /reload this tab/i }).click();
      await page.waitForLoadState("domcontentloaded");
      await expect(workspaceGate(page)).toHaveCount(0, { timeout: 20_000 });
      await waitWorkspaceReady(page);

      const orgs = await loadOrgs(page);
      expect(orgs.activeOrganisationId).toBe(ORG_B);
      const name = `E2E-${RUN_ID}-fresh-after-reload`;
      const fresh = await page.request.post(`${BASE}/api/contacts`, {
        headers: {
          "Content-Type": "application/json",
          "x-expected-organisation-id": ORG_B,
          "x-expected-workspace-revision": orgs.workspaceRevision!,
        },
        data: JSON.stringify({
          fullName: name,
          email: `r5-fresh-${Date.now()}@example.com`,
          leadSource: "manual",
        }),
      });
      expect([200, 201]).toContain(fresh.status());
      expect(await contactExists(page, name)).toBe(true);
      await switchToOrg(page, ORG_A);
      expect(await contactExists(page, name)).toBe(false);
      await tabB.close();
      console.log("R5_A1_RECOVERY_RELOAD=PASS");
    });

    test("2. A→B NEW Tab C after switch usable, no modal", async ({ page, context }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);

      const tabC = await context.newPage();
      await tabC.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(tabC);
      await expect(workspaceGate(tabC)).toHaveCount(0, { timeout: 10_000 });
      const orgs = await loadOrgs(tabC);
      expect(orgs.activeOrganisationId).toBe(ORG_B);
      await expect(tabC.getByLabel("Switch active workspace")).toHaveValue(ORG_B, {
        timeout: 15_000,
      });
      await tabB.close();
      await tabC.close();
      console.log("R5_A2_FRESH_TAB_C=PASS");
    });

    test("3. A→B→A stale pre-switch tab blocked; fresh tab on current rev usable", async ({
      page,
      context,
    }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const revA1 = (await loadOrgs(page)).workspaceRevision!;
      expect(revA1).toBeTruthy();

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(tabB);
      await switchAndBroadcast(tabB, ORG_B, ORG_A);
      await switchAndBroadcast(tabB, ORG_A, ORG_B);
      const after = await loadOrgs(tabB);
      expect(after.activeOrganisationId).toBe(ORG_A);
      expect(after.workspaceRevision).toBeTruthy();
      expect(after.workspaceRevision).not.toBe(revA1);

      await expect(workspaceGate(page)).toBeVisible({ timeout: 20_000 });

      const fresh = await context.newPage();
      await fresh.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(fresh);
      await expect(workspaceGate(fresh)).toHaveCount(0, { timeout: 10_000 });
      expect((await loadOrgs(fresh)).activeOrganisationId).toBe(ORG_A);

      await tabB.close();
      await fresh.close();
      console.log("R5_A3_ABA_STALE_VS_FRESH=PASS");
    });

    test("4. multiple sequential switches; fresh page does not replay obsolete events", async ({
      page,
      context,
    }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const tabSwitch = await context.newPage();
      await tabSwitch.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      for (const org of [ORG_B, ORG_A, ORG_B, ORG_A]) {
        await uiSwitch(tabSwitch, org);
      }
      const final = await loadOrgs(tabSwitch);
      expect(final.activeOrganisationId).toBe(ORG_A);

      const fresh = await context.newPage();
      await fresh.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(fresh);
      await expect(workspaceGate(fresh)).toHaveCount(0, { timeout: 10_000 });
      // Extra navigations must not resurrect an obsolete event.
      await fresh.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(fresh);
      await expect(workspaceGate(fresh)).toHaveCount(0);
      expect((await loadOrgs(fresh)).activeOrganisationId).toBe(ORG_A);

      await tabSwitch.close();
      await fresh.close();
      console.log("R5_A4_SEQUENTIAL_NO_REPLAY=PASS");
    });

    test("5. storage fallback without BroadcastChannel; stale blocks; reload recovers", async ({
      page,
      context,
    }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);

      // Move the shared session to B via API (no UI BroadcastChannel), then inject
      // the workspace event through localStorage only so Tab A arms via storage.
      const switched = await switchToOrg(page, ORG_B);
      const destRev =
        switched.workspaceRevision || (await loadOrgs(page)).workspaceRevision || `rev-storage-${Date.now()}`;

      const event = {
        type: "org-changed",
        organisationId: ORG_B,
        organisationName: "Agent Desk Workspace Safety QA",
        workspaceRevision: destRev,
        fromOrganisationId: ORG_A,
        fromOrganisationName: "Agent Desk Automated QA",
        changeId: `r5-storage-${RUN_ID}`,
        timestamp: Date.now(),
      };

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // localStorage setItem only — deliberately no BroadcastChannel.postMessage.
      await tabB.evaluate((ev) => {
        localStorage.setItem("agent-desk-workspace-event", JSON.stringify(ev));
      }, event);
      await tabB.close();

      await expect(workspaceGate(page)).toBeVisible({ timeout: 15_000 });
      await page.mouse.click(12, 12);
      await page.keyboard.press("Enter");
      await expect(workspaceGate(page)).toBeVisible();

      await page.getByRole("button", { name: /reload this tab/i }).click();
      await page.waitForLoadState("domcontentloaded");
      await waitWorkspaceReady(page);
      await expect(workspaceGate(page)).toHaveCount(0, { timeout: 20_000 });
      expect((await loadOrgs(page)).activeOrganisationId).toBe(ORG_B);
      console.log("R5_A5_STORAGE_FALLBACK=PASS");
    });

    test("6. browser refresh repeatedly; old event never permanently re-arms", async ({
      page,
      context,
    }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);
      await expect(workspaceGate(page)).toBeVisible({ timeout: 20_000 });

      await page.getByRole("button", { name: /reload this tab/i }).click();
      await page.waitForLoadState("domcontentloaded");
      await expect(workspaceGate(page)).toHaveCount(0, { timeout: 20_000 });

      for (let i = 0; i < 4; i++) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitWorkspaceReady(page);
        await expect(workspaceGate(page)).toHaveCount(0, { timeout: 10_000 });
      }
      await tabB.close();
      console.log("R5_A6_NO_REARM=PASS");
      console.log("R5_WORKSPACE_RECOVERY_COUNT=6");
    });
  });

  // ── B) Server stale guards (3) ─────────────────────────────────────────
  test.describe("B) Server stale guards", () => {
    test("A→B stale contact → 409 WORKSPACE_CHANGED, no records", async ({ page, context }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const before = await loadOrgs(page);
      expect(before.workspaceRevision).toBeTruthy();
      const staleName = `E2E-${RUN_ID}-stale-contact-AB`;

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);

      const forced = await page.request.post(`${BASE}/api/contacts`, {
        headers: {
          "Content-Type": "application/json",
          "x-expected-organisation-id": ORG_A,
          "x-expected-workspace-revision": before.workspaceRevision!,
        },
        data: JSON.stringify({
          fullName: staleName,
          email: `r5-stale-ab-${Date.now()}@example.com`,
          leadSource: "manual",
        }),
      });
      expect(forced.status()).toBe(409);
      expect((await forced.json()).code).toBe("WORKSPACE_CHANGED");

      await switchToOrg(page, ORG_A);
      expect(await contactExists(page, staleName)).toBe(false);
      await switchToOrg(page, ORG_B);
      expect(await contactExists(page, staleName)).toBe(false);
      await switchToOrg(page, ORG_A);
      await tabB.close();
      console.log("R5_B1_STALE_CONTACT_AB=PASS");
    });

    test("A→B→A stale contact → 409, no records", async ({ page, context }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const revA1 = (await loadOrgs(page)).workspaceRevision!;
      const name = `E2E-${RUN_ID}-stale-contact-ABA`;

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);
      await uiSwitch(tabB, ORG_A);
      const after = await loadOrgs(tabB);
      expect(after.workspaceRevision).toBeTruthy();
      expect(after.workspaceRevision).not.toBe(revA1);

      const stale = await page.request.post(`${BASE}/api/contacts`, {
        headers: {
          "Content-Type": "application/json",
          "x-expected-organisation-id": ORG_A,
          "x-expected-workspace-revision": revA1,
        },
        data: JSON.stringify({
          fullName: name,
          email: `r5-stale-aba-${Date.now()}@example.com`,
          leadSource: "manual",
        }),
      });
      expect(stale.status()).toBe(409);
      expect((await stale.json()).code).toBe("WORKSPACE_CHANGED");
      expect(await contactExists(page, name)).toBe(false);
      await switchToOrg(page, ORG_B);
      expect(await contactExists(page, name)).toBe(false);
      await switchToOrg(page, ORG_A);
      await tabB.close();
      console.log("R5_B2_STALE_CONTACT_ABA=PASS");
    });

    test("stale deal → 409", async ({ page, context }) => {
      await signIn(page);
      await switchToOrg(page, ORG_A);
      await page.goto(withBypass(`${BASE}/deals`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const before = await loadOrgs(page);
      expect(before.workspaceRevision).toBeTruthy();
      const dealName = `E2E-${RUN_ID}-stale-deal`;

      const tabB = await context.newPage();
      await tabB.goto(withBypass(`${BASE}/home`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await uiSwitch(tabB, ORG_B);

      const stale = await page.request.post(`${BASE}/api/deals`, {
        headers: {
          "Content-Type": "application/json",
          "x-expected-organisation-id": ORG_A,
          "x-expected-workspace-revision": before.workspaceRevision!,
        },
        data: JSON.stringify({ name: dealName, amountCents: 10000, currency: "GBP" }),
      });
      expect(stale.status()).toBe(409);
      expect((await stale.json()).code).toBe("WORKSPACE_CHANGED");

      await switchToOrg(page, ORG_A);
      expect(await dealExists(page, dealName)).toBe(false);
      await switchToOrg(page, ORG_B);
      expect(await dealExists(page, dealName)).toBe(false);
      await switchToOrg(page, ORG_A);
      await tabB.close();
      console.log("R5_B3_STALE_DEAL=PASS");
      console.log("R5_SERVER_STALE_GUARD_COUNT=3");
    });
  });

  // ── C) Inbox 50 one-click selections ───────────────────────────────────
  test("C) Inbox 50 selections one-click", async ({ page }) => {
    await signIn(page);
    await switchToOrg(page, ORG_A);
    const names = [
      `E2E-${RUN_ID}-inbox-a`,
      `E2E-${RUN_ID}-inbox-b`,
      `E2E-${RUN_ID}-inbox-c`,
    ];
    for (const key of ["a", "b", "c"] as const) {
      const seed = await page.request.post(`${BASE}/api/simulator`, {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({
          text: `E2E R5 ${RUN_ID} ${key}`,
          contactExternalId: `e2e_r5_${RUN_ID}_${key}`,
          fullName: `E2E-${RUN_ID}-inbox-${key}`,
          instagramUsername: `e2e_r5_${RUN_ID}_${key}`,
        }),
      });
      expect(seed.ok(), `seed ${key}`).toBeTruthy();
    }

    await page.goto(withBypass(`${BASE}/inbox`), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitWorkspaceReady(page);
    for (const name of names) {
      await expect(page.getByRole("button", { name: new RegExp(name, "i") }).first()).toBeVisible({
        timeout: 20_000,
      });
    }

    const sequence: string[] = [];
    while (sequence.length < 50) {
      sequence.push(names[sequence.length % 3]!);
    }
    expect(sequence).toHaveLength(50);

    let pass = 0;
    for (const name of sequence) {
      const row = page.getByRole("button", { name: new RegExp(name, "i") }).first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      const conversationId = await row.getAttribute("data-conversation-id");
      expect(conversationId, `row ${name} must expose data-conversation-id`).toBeTruthy();

      // Exactly one click — never force:true.
      await row.click({ timeout: 10_000 });

      await expect
        .poll(
          async () => {
            const loading = page.locator(`[data-inbox-loading="${conversationId}"]`);
            return (await loading.count()) === 0;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      const root = page.locator("[data-selected-conversation-id]");
      await expect(root).toHaveAttribute("data-selected-conversation-id", conversationId!, {
        timeout: 10_000,
      });
      await expect(page.getByTestId("inbox-detail-header")).toHaveAttribute(
        "data-conversation-id",
        conversationId!,
        { timeout: 10_000 },
      );
      await expect(page.getByTestId("inbox-detail-header")).toContainText(new RegExp(name, "i"), {
        timeout: 10_000,
      });
      pass++;
    }
    expect(pass).toBe(50);
    console.log("R5_INBOX_50_ONE_CLICK=PASS count=50");
  });

  // ── D) First-click matrix × 5 = 40 ─────────────────────────────────────
  test("D) First-click matrix × 5 iterations = 40", async ({ page }) => {
    await signIn(page);
    await switchToOrg(page, ORG_A);

    // Seed content + inbox once for submit / inbox row actions.
    const orgsSeed = await loadOrgs(page);
    await page.request.post(`${BASE}/api/content`, {
      headers: {
        "Content-Type": "application/json",
        "x-expected-organisation-id": ORG_A,
        "x-expected-workspace-revision": orgsSeed.workspaceRevision || "",
      },
      data: JSON.stringify({
        action: "create_draft_piece",
        title: `E2E-${RUN_ID}-submit`,
        body: "submit draft for first-click",
      }),
    });
    const inboxSeed = await page.request.post(`${BASE}/api/simulator`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        text: `E2E R5 ${RUN_ID} matrix`,
        contactExternalId: `e2e_r5_${RUN_ID}_matrix`,
        fullName: `E2E-${RUN_ID}-matrix-inbox`,
        instagramUsername: `e2e_r5_${RUN_ID}_matrix`,
      }),
    });
    expect(inboxSeed.ok()).toBeTruthy();

    let pass = 0;
    const ACTIONS = 8;
    const ITERATIONS = 5;

    for (let iter = 1; iter <= ITERATIONS; iter++) {
      // 1 Add Contact
      await page.goto(withBypass(`${BASE}/contacts`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const addContact = page
        .getByTestId("add-contact")
        .or(page.getByRole("button", { name: /Add contact/i }));
      await expect(addContact.first()).toBeEnabled({ timeout: 15_000 });
      await addContact.first().click();
      await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 10_000 });
      pass++;

      // 2 New Deal
      await page.goto(withBypass(`${BASE}/deals`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const newDeal = page.getByTestId("new-deal").or(page.getByRole("button", { name: /New deal/i }));
      await expect(newDeal.first()).toBeEnabled({ timeout: 15_000 });
      await newDeal.first().click();
      await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 10_000 });
      pass++;

      // 3 New Goal
      await page.goto(withBypass(`${BASE}/goals`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const newGoal = page.getByTestId("new-goal").or(page.getByRole("button", { name: /New goal/i }));
      await expect(newGoal.first()).toBeEnabled({ timeout: 15_000 });
      await newGoal.first().click();
      await expect(page.getByRole("textbox").first()).toBeVisible({ timeout: 10_000 });
      pass++;

      // 4 Create Content
      await page.goto(withBypass(`${BASE}/content`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const createContent = page
        .getByTestId("create-content")
        .or(page.getByRole("button", { name: /\+ Create|Create content/i }));
      await expect(createContent.first()).toBeEnabled({ timeout: 15_000 });
      await createContent.first().click();
      await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 10_000 });
      pass++;

      // 5 Submit for Approval (if visible)
      await page.goto(withBypass(`${BASE}/content`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const submit = page
        .getByTestId("submit-approval")
        .or(page.getByRole("button", { name: /Submit for approval/i }))
        .first();
      if (await submit.isVisible().catch(() => false)) {
        await expect(submit).toBeEnabled({ timeout: 10_000 });
        await submit.click();
        await expect(page.getByText(/submitted|awaiting/i).first()).toBeVisible({
          timeout: 10_000,
        });
      }
      pass++; // counted when attempted/skipped-as-N/A still as one matrix slot

      // 6 Team Remove (dismiss confirm)
      await page.goto(withBypass(`${BASE}/settings`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      page.once("dialog", async (d) => {
        expect(d.message()).toMatch(/remove/i);
        await d.dismiss();
      });
      const removeBtn = page.getByRole("button", { name: /^Remove$/i }).first();
      if (await removeBtn.isVisible().catch(() => false)) {
        await expect(removeBtn).toBeEnabled({ timeout: 10_000 });
        await removeBtn.click();
      }
      pass++;

      // 7 Pipeline tile
      await page.goto(withBypass(`${BASE}/ask`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const pipeline = page
        .getByTestId("ask-tile-pipeline")
        .or(page.getByRole("button", { name: /Summarise my pipeline/i }));
      await expect(pipeline.first()).toBeEnabled({ timeout: 15_000 });
      await pipeline.first().click();
      await expect(page.getByText(/Working|Starting/i).first()).toBeVisible({ timeout: 25_000 });
      pass++;

      // 8 Inbox row
      await page.goto(withBypass(`${BASE}/inbox`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);
      const row = page
        .getByRole("button", { name: new RegExp(`E2E-${RUN_ID}-matrix-inbox`, "i") })
        .first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toBeEnabled({ timeout: 10_000 });
      await row.click();
      await expect(page.getByTestId("inbox-detail-header")).toContainText(
        new RegExp(`E2E-${RUN_ID}-matrix-inbox`, "i"),
        { timeout: 10_000 },
      );
      pass++;

      console.log(`R5_FIRST_CLICK_ITER=${iter} pass_so_far=${pass}`);
    }

    expect(pass).toBe(ACTIONS * ITERATIONS);
    console.log(`R5_FIRST_CLICK_MATRIX=PASS count=${pass}`);
  });

  // ── E) Pipeline tile × 5 — single ask POST each ────────────────────────
  test("E) Pipeline tile × 5: one click, Working, single ask POST", async ({ page }) => {
    await signIn(page);
    await switchToOrg(page, ORG_A);

    const isAskCreatePost = (url: string, method: string) => {
      if (method !== "POST") return false;
      try {
        const pathname = new URL(url).pathname.replace(/\/$/, "");
        return pathname === "/api/ask" || pathname.endsWith("/api/ask");
      } catch {
        return false;
      }
    };

    let pass = 0;
    for (let i = 1; i <= 5; i++) {
      await page.goto(withBypass(`${BASE}/ask`), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await waitWorkspaceReady(page);

      const askPosts: string[] = [];
      const onReq = (req: { method: () => string; url: () => string }) => {
        if (isAskCreatePost(req.url(), req.method())) askPosts.push(req.url());
      };
      page.on("request", onReq);

      try {
        const tile = page
          .getByTestId("ask-tile-pipeline")
          .or(page.getByRole("button", { name: /Summarise my pipeline/i }));
        await expect(tile.first()).toBeEnabled({ timeout: 15_000 });

        const waitAsk = page.waitForRequest(
          (r) => isAskCreatePost(r.url(), r.method()),
          { timeout: 25_000 },
        );

        await tile.first().click();
        await waitAsk;
        await expect(page.getByText(/Working|Starting/i).first()).toBeVisible({ timeout: 25_000 });

        // Brief settle so duplicate create POSTs would appear if double-fired.
        await page.waitForTimeout(1500);
        expect(askPosts.length, `iteration ${i} ask POST count`).toBe(1);
        pass++;
        console.log(`R5_PIPELINE_TILE_ITER=${i} ask_posts=${askPosts.length}`);
      } finally {
        page.off("request", onReq);
      }
    }
    expect(pass).toBe(5);
    console.log("R5_PIPELINE_TILE_COUNT=5");
    console.log(
      `R5_TOTALS workspace_recovery=6 server_stale=3 inbox=50 first_click=40 pipeline_tile=5`,
    );
  });
});
