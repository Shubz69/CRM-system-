/**
 * Hosted production Playwright acceptance — env-driven, non-destructive.
 *
 * Required for hosted runs:
 *   PLAYWRIGHT_SKIP_WEBSERVER=1
 *   PLAYWRIGHT_BASE_URL=https://<production-host>   (or APP_URL — must not be localhost)
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
 *   E2E_READONLY_EMAIL / E2E_READONLY_PASSWORD
 * Optional:
 *   E2E_PLATFORM_ADMIN_EMAIL / E2E_PLATFORM_ADMIN_PASSWORD
 *   E2E_WORKSPACE_NAME   (regex-friendly display name; default matches any non-empty workspace shell)
 *
 * Never hard-code passwords, tokens, or workspace ids.
 * Do not commit QA/hosted-production-acceptance-report.json (local artifact).
 */
import { config as loadEnv } from "dotenv";
import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from "@playwright/test";
import fs from "fs";
import path from "path";

loadEnv({ path: path.join(process.cwd(), ".env") });

function resolveHostedBaseUrl(): string {
  const hosted = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1";
  const explicit = (process.env.PLAYWRIGHT_BASE_URL || "").trim();
  const appUrl = (process.env.APP_URL || "").trim();

  if (hosted) {
    const candidate = (explicit || appUrl).replace(/\/$/, "");
    if (!candidate) {
      throw new Error(
        "HOSTED_E2E_REQUIRES_URL: set PLAYWRIGHT_BASE_URL (preferred) or APP_URL when PLAYWRIGHT_SKIP_WEBSERVER=1",
      );
    }
    if (/localhost|127\.0\.0\.1/i.test(candidate)) {
      throw new Error(
        "HOSTED_E2E_LOCALHOST_FORBIDDEN: hosted production acceptance must not target localhost",
      );
    }
    return candidate;
  }

  return (explicit || appUrl || "http://localhost:3000").replace(/\/$/, "");
}

const BASE = resolveHostedBaseUrl();

const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL || "",
  password: process.env.E2E_ADMIN_PASSWORD || "",
};
const READONLY = {
  email: process.env.E2E_READONLY_EMAIL || "",
  password: process.env.E2E_READONLY_PASSWORD || "",
};
const PLATFORM = {
  email: process.env.E2E_PLATFORM_ADMIN_EMAIL || "",
  password: process.env.E2E_PLATFORM_ADMIN_PASSWORD || "",
};

const EXPECTED_WORKSPACE = process.env.E2E_WORKSPACE_NAME
  ? new RegExp(process.env.E2E_WORKSPACE_NAME, "i")
  : /\S/;

const REPORT_PATH = path.join(process.cwd(), "QA", "hosted-production-acceptance-report.json");

type ConsoleEntry = { type: string; text: string; url: string };
type NetFail = { url: string; status: number; method: string };

const consoleErrors: ConsoleEntry[] = [];
const pageExceptions: { message: string; url: string }[] = [];
const failedNetwork: NetFail[] = [];

function credsOk(c: { email: string; password: string }) {
  return Boolean(c.email && c.password);
}

function isBenignConsole(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("favicon") ||
    t.includes("extension") ||
    t.includes("chrome-extension") ||
    t.includes("download the react devtools") ||
    t.includes("third-party cookie") ||
    t.includes("net::err_blocked_by_client") ||
    t.includes("failed to load resource: the server responded with a status of 404")
  );
}

async function attachWatchers(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isBenignConsole(text)) return;
    consoleErrors.push({ type: msg.type(), text: text.slice(0, 500), url: page.url() });
  });
  page.on("pageerror", (err) => {
    pageExceptions.push({ message: String(err.message || err).slice(0, 500), url: page.url() });
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status < 500) return;
    const url = res.url();
    if (!url.includes(new URL(BASE).host)) return;
    failedNetwork.push({ url: url.slice(0, 300), status, method: res.request().method() });
  });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  const outcome = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 })
      .then(() => "ok" as const),
    page
      .getByText(/invalid email or password/i)
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "invalid" as const),
  ]);
  if (outcome === "invalid") {
    throw new Error("AUTH_REJECTED: credentials rejected by production (email redacted)");
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

async function newAuthedContext(
  browser: Browser,
  creds: { email: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await attachWatchers(page);
  await signIn(page, creds.email, creds.password);
  return { context, page };
}

async function settle(page: Page, ms = 800) {
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function gotoRoute(page: Page, route: string) {
  const res = await page.goto(`${BASE}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await settle(page);
  return res;
}

function assertPageOk(page: Page, res: import("@playwright/test").Response | null, route: string) {
  expect(res, `${route} navigated`).toBeTruthy();
  const status = res!.status();
  expect(status, `${route} HTTP status`).toBeLessThan(500);
  expect(page.url(), `${route} not stuck on login`).not.toMatch(/\/login/);
  expect(page.locator("body")).toBeVisible();
}

async function apiJson(
  request: APIRequestContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathName: string,
  body?: unknown,
) {
  const res = await request.fetch(`${BASE}${pathName}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status(), json };
}

const ADMIN_ROUTES: { route: string; hint: RegExp }[] = [
  { route: "/home", hint: /home|attention|today|workspace/i },
  { route: "/ask", hint: /ask|request|how can|type/i },
  { route: "/inbox", hint: /inbox|conversation|message/i },
  { route: "/crm", hint: /crm|contact|pipeline|deal/i },
  { route: "/contacts", hint: /contact/i },
  { route: "/companies", hint: /compan/i },
  { route: "/deals", hint: /deal/i },
  { route: "/pipeline", hint: /pipeline|stage|deal/i },
  { route: "/growth", hint: /growth|opportunit|campaign/i },
  { route: "/opportunities", hint: /opportunit/i },
  { route: "/research", hint: /research|topic|listen/i },
  { route: "/content", hint: /content|draft|calendar/i },
  { route: "/goals", hint: /goal/i },
  { route: "/business-context", hint: /business|profile|context/i },
  { route: "/knowledge", hint: /knowledge|document/i },
  { route: "/automations", hint: /automation|rule/i },
  { route: "/analytics", hint: /analytic|report|metric|insight/i },
  { route: "/integrations", hint: /integration|manychat|connect|instagram/i },
  { route: "/settings", hint: /setting|team|workspace|profile/i },
];

test.describe.configure({ mode: "default" });
test.setTimeout(480_000);

test.describe("Hosted production acceptance", () => {
  test.beforeAll(() => {
    expect(process.env.PLAYWRIGHT_SKIP_WEBSERVER, "hosted suite requires PLAYWRIGHT_SKIP_WEBSERVER=1").toBe(
      "1",
    );
    expect(BASE, "must target a non-localhost host").not.toMatch(/localhost|127\.0\.0\.1/i);
    expect(credsOk(ADMIN), "E2E_ADMIN_* required").toBe(true);
    expect(credsOk(READONLY), "E2E_READONLY_* required").toBe(true);
  });

  test.afterAll(() => {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        {
          base: BASE,
          consoleErrors,
          pageExceptions,
          failedNetwork,
          platformAdminAutomatedE2E: credsOk(PLATFORM) ? "READY" : "BLOCKED_BY_QA_IDENTITY",
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });

  test("1) production surface + health", async ({ request }) => {
    const health = await apiJson(request, "GET", "/api/health");
    expect(health.status).toBe(200);
    expect((health.json as { ok?: boolean }).ok).toBe(true);
    const login = await request.get(`${BASE}/login`);
    expect(login.status()).toBe(200);
  });

  test("2) Administrator login, workspace, routes, admin denial", async ({ browser }) => {
    const { context, page } = await newAuthedContext(browser, ADMIN);
    const request = context.request;

    await gotoRoute(page, "/home");
    const shell = await page.locator("body").innerText();
    expect(shell, "workspace identity").toMatch(EXPECTED_WORKSPACE);

    const adminNav = page.getByRole("navigation").getByText(/^Admin$/i);
    await expect(adminNav, "platform Admin nav absent for workspace admin").toHaveCount(0);

    for (const { route, hint } of ADMIN_ROUTES) {
      const res = await gotoRoute(page, route);
      assertPageOk(page, res, route);
      const text = await page.locator("body").innerText();
      expect(text, `${route} primary content`).toMatch(hint);
      expect(text.toLowerCase()).not.toMatch(/application error|internal server error/);
    }

    await gotoRoute(page, "/settings");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const membersRes = await apiJson(request, "GET", "/api/workspace/members");
    expect([200], "admin can list members").toContain(membersRes.status);

    await gotoRoute(page, "/integrations");
    // Canonical customer surface is Social Accounts (IG/LI/YT) — not legacy ManyChat setup.
    await expect(page.getByText(/Social Accounts/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#manychat-setup")).toHaveCount(0);

    const adminPage = await gotoRoute(page, "/admin");
    const adminStatus = adminPage?.status() ?? 0;
    const adminUrl = page.url();
    const adminText = await page.locator("body").innerText();
    const adminDenied =
      adminStatus === 403 ||
      adminUrl.includes("/login") ||
      adminUrl.includes("/home") ||
      adminUrl.includes("/ask") ||
      /forbidden|not authorised|not authorized|access denied|don't have access|do not have access/i.test(
        adminText,
      ) ||
      !(await page.getByRole("heading", { name: /admin|platform|workspaces/i }).count());
    expect(adminDenied, "workspace admin must not use /admin").toBe(true);

    const workspacesApi = await apiJson(request, "GET", "/api/admin/workspaces");
    expect([401, 403]).toContain(workspacesApi.status);
    const healthDetailed = await apiJson(request, "GET", "/api/admin/health/detailed");
    expect([401, 403]).toContain(healthDetailed.status);

    await context.close();
  });

  test("3) Read Only login, routes, mutation denial, /admin denial", async ({ browser }) => {
    const { context, page } = await newAuthedContext(browser, READONLY);
    const request = context.request;

    await gotoRoute(page, "/home");
    expect(await page.locator("body").innerText()).toMatch(EXPECTED_WORKSPACE);
    await expect(page.getByRole("navigation").getByText(/^Admin$/i)).toHaveCount(0);

    for (const route of ["/home", "/crm", "/contacts", "/companies", "/deals", "/pipeline", "/growth", "/analytics"]) {
      const res = await gotoRoute(page, route);
      assertPageOk(page, res, route);
    }

    const company = await apiJson(request, "POST", "/api/companies", {
      name: `E2E-READONLY-SHOULD-FAIL-${Date.now()}`,
    });
    expect([401, 403]).toContain(company.status);

    const contact = await apiJson(request, "POST", "/api/contacts", {
      fullName: `E2E Readonly ${Date.now()}`,
      organisationId: "fake-org-should-be-ignored",
    });
    expect([401, 403, 404, 405]).toContain(contact.status);
    if (contact.status === 200 || contact.status === 201) {
      throw new Error("PERMISSION BUG: READ_ONLY created a contact");
    }

    const invite = await apiJson(request, "POST", "/api/workspace/members", {
      email: "should-not-invite@example.com",
      role: "SALES_AGENT",
    });
    expect([401, 403]).toContain(invite.status);

    const manychat = await apiJson(request, "POST", "/api/integrations/manychat", {
      action: "save_api_token",
      apiToken: "fake-token-must-not-save",
    });
    expect([401, 403]).toContain(manychat.status);

    const settingsPatch = await apiJson(request, "PATCH", "/api/settings", {
      organisationId: "fake-org",
      name: "Hijack",
    });
    expect([401, 403, 404, 405, 400]).toContain(settingsPatch.status);

    const adminPage = await gotoRoute(page, "/admin");
    const adminUrl = page.url();
    const adminText = await page.locator("body").innerText();
    const denied =
      (adminPage?.status() ?? 0) === 403 ||
      adminUrl.includes("/login") ||
      /forbidden|not authorised|not authorized|access denied|don't have access/i.test(adminText) ||
      !(await page.getByText(/Platform|Workspaces|System health/i).count());
    expect(denied).toBe(true);

    const workspacesApi = await apiJson(request, "GET", "/api/admin/workspaces");
    expect([401, 403]).toContain(workspacesApi.status);

    await context.close();
  });

  test("4) Platform Admin login, /admin access, read-only platform API", async ({ browser }) => {
    test.skip(!credsOk(PLATFORM), "PLATFORM_ADMIN_AUTOMATED_E2E = BLOCKED_BY_QA_IDENTITY");

    const { context, page } = await newAuthedContext(browser, PLATFORM);
    const request = context.request;

    await gotoRoute(page, "/home");
    await expect(page.getByRole("navigation").getByText(/^Admin$/i)).toBeVisible({ timeout: 20_000 });

    const adminRes = await gotoRoute(page, "/admin");
    assertPageOk(page, adminRes, "/admin");
    const adminText = await page.locator("body").innerText();
    expect(adminText).toMatch(/workspace|health|user|platform/i);

    const workspacesApi = await apiJson(request, "GET", "/api/admin/workspaces");
    expect(workspacesApi.status).toBe(200);

    // Read-only probe only — do not mutate production orgs
    const healthDetailed = await apiJson(request, "GET", "/api/admin/health/detailed");
    expect([200, 403]).toContain(healthDetailed.status);

    await context.close();
  });

  test("5) Tenant boundary — client organisationId ignored", async ({ browser }) => {
    const { context } = await newAuthedContext(browser, ADMIN);
    const request = context.request;

    const forged = await apiJson(request, "POST", "/api/companies", {
      name: `E2E-tenant-probe-${Date.now()}`,
      organisationId: "org_forged_should_never_win",
    });
    if (forged.status === 200 || forged.status === 201) {
      const id = (forged.json as { id?: string }).id;
      expect(id, "company id returned").toBeTruthy();
      const list = await apiJson(request, "GET", "/api/companies");
      expect(list.status).toBe(200);
      const companies = (list.json as { companies?: { id: string; name: string }[] }).companies || [];
      expect(companies.find((c) => c.id === id), "created company visible in session org list").toBeTruthy();
      await request.fetch(`${BASE}/api/companies/${id}`, { method: "DELETE" }).catch(() => undefined);
    } else {
      expect(forged.status).toBeLessThan(500);
    }

    const membersForged = await apiJson(request, "POST", "/api/workspace/members", {
      email: "forged-invite@example.com",
      role: "READ_ONLY",
      organisationId: "another-org-id",
    });
    expect(membersForged.status).toBeLessThan(500);
    if (membersForged.status === 200 || membersForged.status === 201) {
      const invId = (membersForged.json as { inviteId?: string }).inviteId;
      if (invId) await apiJson(request, "POST", `/api/workspace/invitations/${invId}/revoke`);
    }

    await context.close();
  });

  test("6) Onboarding — accepted memberships visible; invite replay N/A without token", async ({
    browser,
  }) => {
    const { context } = await newAuthedContext(browser, ADMIN);
    const request = context.request;
    const membersRes = await apiJson(request, "GET", "/api/workspace/members");
    expect(membersRes.status).toBe(200);
    const body = membersRes.json as {
      members?: { email?: string; role?: string; user?: { email?: string } }[];
      invitations?: { status?: string; email?: string }[];
    };
    const members = body.members || [];
    const memberEmail = (m: { email?: string; user?: { email?: string } }) =>
      (m.user?.email || m.email || "").toLowerCase();
    const adminMember = members.find((m) => memberEmail(m) === ADMIN.email.toLowerCase());
    const roMember = members.find((m) => memberEmail(m) === READONLY.email.toLowerCase());
    expect(adminMember, "Administrator membership").toBeTruthy();
    expect(roMember, "Read Only membership").toBeTruthy();
    expect(["ADMINISTRATOR", "OWNER", "SUPER_ADMIN"]).toContain(adminMember!.role);
    expect(roMember!.role).toBe("READ_ONLY");
    expect(process.env.E2E_INVITE_TOKEN || "", "no plaintext invite token expected").toBe("");
    await context.close();
  });

  test("7) Four answer modes — contract + lightweight runs", async ({ browser }) => {
    const { context, page } = await newAuthedContext(browser, ADMIN);
    const request = context.request;

    const roCtx = await browser.newContext({ baseURL: BASE });
    const roPage = await roCtx.newPage();
    await signIn(roPage, READONLY.email, READONLY.password);
    const roAsk = await apiJson(roCtx.request, "POST", "/api/ask", {
      request: "quick status of our pipeline",
      answerMode: "QUICK",
    });
    expect([401, 403]).toContain(roAsk.status);
    await roCtx.close();

    const modes = ["QUICK", "EXECUTIVE", "ACTION", "DEEP"] as const;
    const runIds: Record<string, string> = {};

    for (const mode of modes) {
      const prompt =
        mode === "QUICK"
          ? "In one sentence, what should we focus on this week using only our internal business context?"
          : mode === "EXECUTIVE"
            ? "Summarise our current business priorities for management using only internal context."
            : mode === "ACTION"
              ? "Tell me exactly what to do next week using only internal business context. Keep it short."
              : "Give a brief structured report on our internal business context only — no external scraping.";

      const created = await apiJson(request, "POST", "/api/ask", {
        request: prompt,
        answerMode: mode,
      });
      expect(created.status, `${mode} ask create`).toBe(200);
      const body = created.json as { ok?: boolean; runId?: string; answerMode?: string };
      expect(body.ok).toBe(true);
      expect(body.runId).toBeTruthy();
      expect(body.answerMode).toBe(mode);
      runIds[mode] = body.runId!;
    }

    async function poll(runId: string, ms = 45_000) {
      const start = Date.now();
      let last: Record<string, unknown> = {};
      while (Date.now() - start < ms) {
        const prog = await apiJson(request, "GET", `/api/ask/${runId}`);
        if (prog.status === 200 && prog.json && typeof prog.json === "object") {
          last = prog.json as Record<string, unknown>;
          const status = String(last.status || "");
          if (["COMPLETED", "FAILED", "AWAITING_CLARIFICATION", "AWAITING_USER"].includes(status)) {
            return last;
          }
          if (last.clarificationQuestion || last.finalOutput) return last;
        }
        await page.waitForTimeout(2500);
      }
      return last;
    }

    const quickDone = await poll(runIds.QUICK, 60_000);
    const qClar = String(quickDone.clarificationQuestion || "");
    expect(qClar.toLowerCase()).not.toMatch(/how would you like this answered/);

    await gotoRoute(page, "/ask");
    expect(await page.locator("body").innerText()).toMatch(/ask|request/i);
    await context.close();
  });

  test("8) Integrations customer surface — Social Accounts only; provider APIs denied", async ({
    browser,
  }) => {
    const { context, page } = await newAuthedContext(browser, ADMIN);
    await gotoRoute(page, "/integrations");
    await settle(page, 1500);
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Social Accounts/i);
    expect(body).toMatch(/Instagram|LinkedIn|YouTube/i);
    expect(body).not.toMatch(/ManyChat|Zernio|Ayrshare|Claude|Anthropic/i);
    await context.close();

    const ro = await newAuthedContext(browser, READONLY);
    const mutate = await apiJson(ro.context.request, "POST", "/api/integrations/manychat", {
      action: "disconnect",
    });
    expect([401, 403]).toContain(mutate.status);
    await ro.context.close();
  });

  test("9) Meta Instagram API — workspace users denied; no crash on Integrations", async ({
    browser,
  }) => {
    const { context, page } = await newAuthedContext(browser, ADMIN);
    await gotoRoute(page, "/integrations");
    await settle(page, 1500);
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Instagram/i);
    expect(body.toLowerCase()).not.toMatch(/application error|internal server error/);

    const status = await apiJson(context.request, "GET", "/api/integrations/meta-instagram");
    expect([401, 403]).toContain(status.status);
    await context.close();

    const ro = await newAuthedContext(browser, READONLY);
    const mutate = await apiJson(ro.context.request, "POST", "/api/integrations/meta-instagram", {
      action: "disconnect",
    });
    expect([401, 403]).toContain(mutate.status);
    await ro.context.close();
  });

  test("10) Console / network — no production 5xx storms during suite", async () => {
    const serverFails = failedNetwork.filter((f) => f.status >= 500);
    expect(serverFails, JSON.stringify(serverFails.slice(0, 5))).toHaveLength(0);
  });
});
