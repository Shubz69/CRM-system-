/**
 * Closure live probe on PLAYWRIGHT_BASE_URL.
 * Tonaura Ask + research + LifeKeep operator isolation.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import fs from "fs";
import { chromium } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });
loadEnv({ path: path.join(process.cwd(), ".env.local") });

const BASE = (process.env.PLAYWRIGHT_BASE_URL || "").replace(/\/$/, "");
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const TONAURA = "cmtwuufvy0000le04ljdz6mf1";
const LIFEKEEP = "cmtwuunhe000qle04kyh9ptzq";
const PROVIDER_RE =
  /\b(openai|anthropic|claude|tavily|exa|apify|prisma|postgres|redis|api key|embedding|zod)\b/i;

if (!BASE) {
  console.error("PLAYWRIGHT_BASE_URL required");
  process.exit(2);
}

async function login(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45000 });
}

async function switchOrg(page, orgId) {
  const res = await page.evaluate(async (id) => {
    const r = await fetch("/api/session/organisation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationId: id }),
    });
    return { http: r.status, j: await r.json().catch(() => ({})) };
  }, orgId);
  if (res.http !== 200) {
    throw new Error(`org switch ${res.http} ${JSON.stringify(res.j).slice(0, 160)}`);
  }
}

async function ask(page, request, answerMode = "QUICK") {
  const t0 = Date.now();
  const created = await page.evaluate(
    async ({ request, answerMode }) => {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, answerMode }),
      });
      return { http: r.status, j: await r.json().catch(() => ({})) };
    },
    { request, answerMode },
  );
  let body = created.j;
  const runId = body?.runId;
  const terminal = new Set([
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "AWAITING_CLARIFICATION",
    "CANCELLED",
  ]);
  for (let i = 0; i < 14 && runId && !terminal.has(body?.status); i++) {
    await page.waitForTimeout(3000);
    body = await page.evaluate(async (id) => {
      const r = await fetch(`/api/ask/${id}`);
      return r.json().catch(() => ({}));
    }, runId);
  }
  const fo = body?.finalOutput;
  const text =
    typeof fo === "string"
      ? fo
      : [fo?.summary, fo?.answer, fo?.shortAnswer, fo?.keyFinding, fo?.executiveSummary]
          .filter(Boolean)
          .join("\n") || String(body?.userFacingError || body?.error || "");
  const sources = Array.isArray(fo?.sources) ? fo.sources.length : 0;
  const findings = Array.isArray(fo?.findings) ? fo.findings.length : 0;
  return {
    q: request,
    http: created.http,
    status: body?.status || null,
    clarify: body?.status === "AWAITING_CLARIFICATION" ? 1 : 0,
    preview: String(text).slice(0, 240),
    sources,
    findings,
    researchJobId: fo?.researchJobId || null,
    totalCostCents: body?.totalCostCents ?? created.j?.totalCostCents ?? null,
    costNote: body?.costNote ?? created.j?.costNote ?? null,
    providerLeak: PROVIDER_RE.test(JSON.stringify(body || {})),
    ms: Date.now() - t0,
    runId,
  };
}

const TONAURA_QS = [
  { id: "crm_contacts", q: "How many contacts do we have?" },
  { id: "operator_today", q: "What should I focus on today?" },
  { id: "pipeline", q: "How healthy is my pipeline?" },
  { id: "deals_attention", q: "Which deals need my attention?" },
  { id: "goals", q: "What goal is most at risk?" },
  { id: "content", q: "Give me three content ideas for Tonaura." },
  { id: "research", q: "Research the latest trends relevant to Tonaura." },
  { id: "growth", q: "Why are we not growing?" },
  { id: "marketing", q: "What marketing themes should Tonaura lean into based on our business?" },
  { id: "customers", q: "How can we get our first 100 customers?" },
  { id: "brand_mentions", q: "What are people saying about Tonaura?" },
];

const out = {
  base: BASE,
  startedAt: new Date().toISOString(),
  tonaura: {},
  lifekeep: {},
  tenant: {},
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  extraHTTPHeaders: BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {},
});
const page = await context.newPage();

try {
  await login(
    page,
    process.env.E2E_EMAIL || "",
    process.env.E2E_PASSWORD || "",
  );
  await switchOrg(page, TONAURA);
  for (const c of TONAURA_QS) {
    console.log(`[probe] ${c.id}`);
    out.tonaura[c.id] = await ask(page, c.q);
  }

  const tonRun = out.tonaura.operator_today?.runId;
  const browserB = await chromium.launch({ headless: true });
  const pageB = await (
    await browserB.newContext({
      extraHTTPHeaders: BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {},
    })
  ).newPage();
  try {
    await login(
      pageB,
      process.env.LIFEKEEP_PILOT_EMAIL || "lifekeep.pilot.8d@example.com",
      process.env.LIFEKEEP_PILOT_PASSWORD || "LifeKeepPilot8D!",
    );
    await switchOrg(pageB, LIFEKEEP);
    out.lifekeep.operator_today = await ask(pageB, "What should I focus on today?");
    out.lifekeep.content = await ask(pageB, "What should LifeKeep post this week?");
    if (tonRun) {
      const cross = await pageB.evaluate(async (id) => {
        const r = await fetch(`/api/ask/${id}`);
        return { http: r.status, j: await r.json().catch(() => ({})) };
      }, tonRun);
      out.tenant.crossAskRun = {
        http: cross.http,
        leaked: cross.http === 200 && /Tonaura/i.test(JSON.stringify(cross.j)),
      };
    }
  } finally {
    await browserB.close();
  }
} finally {
  await browser.close();
}

const previews = Object.values(out.tonaura).map((r) => String(r.preview || "").slice(0, 60));
out.askDiversityDistinct = new Set(previews).size >= 5;
out.clarifyCount = Object.values(out.tonaura).reduce((n, r) => n + (r.clarify || 0), 0);
out.researchHasSources = (out.tonaura.research?.sources || 0) > 0;
out.lifeKeepDistinct =
  /LifeKeep/i.test(out.lifekeep.operator_today?.preview || "") &&
  !/Tonaura/i.test(out.lifekeep.operator_today?.preview || "");
out.finishedAt = new Date().toISOString();
fs.writeFileSync("QA/closure-live-probe.json", JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    {
      base: BASE,
      askDiversityDistinct: out.askDiversityDistinct,
      clarifyCount: out.clarifyCount,
      research: {
        status: out.tonaura.research?.status,
        sources: out.tonaura.research?.sources,
        findings: out.tonaura.research?.findings,
        cost: out.tonaura.research?.totalCostCents,
        preview: out.tonaura.research?.preview,
        ms: out.tonaura.research?.ms,
      },
      contentPreview: out.tonaura.content?.preview,
      operatorPreview: out.tonaura.operator_today?.preview,
      lifeKeepDistinct: out.lifeKeepDistinct,
      lifeKeepPreview: out.lifekeep.operator_today?.preview,
      tenant: out.tenant,
      nauraLeak: /NAURA/i.test(JSON.stringify(out.tonaura)),
      synthesisDirect: /DIRECT ANSWER/i.test(out.tonaura.research?.preview || ""),
      growthClarify: out.tonaura.growth?.clarify || 0,
    },
    null,
    2,
  ),
);
