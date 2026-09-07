/**
 * Phase 8A commercial quality benchmark — run against PREVIEW after deploy.
 * Compact polls (2s), max 60s per question fail-fast.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import fs from "fs";
import { chromium } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (process.env.PHASE8A_BASE_URL || process.env.MASTER_PROD_BASE_URL || "").replace(
  /\/$/,
  "",
);
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const ORG_QA = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";

if (!BASE) {
  console.error("Set PHASE8A_BASE_URL to the exact-head preview URL");
  process.exit(1);
}

const out = {
  BASE,
  QUICK: [],
  OPERATOR: [],
  PROSPECTING: [],
  COST: {},
  CONTACT: {},
  BP_REDIRECT: {},
  REGRESSION: {},
};

const browser = await chromium.launch();
const context = await browser.newContext({
  extraHTTPHeaders: BYPASS
    ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" }
    : {},
});
if (BYPASS) {
  await context.addCookies([
    {
      name: "x-vercel-protection-bypass",
      value: BYPASS,
      url: BASE,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}
const page = await context.newPage();

async function api(method, pathName, data) {
  const res = await page.request.fetch(`${BASE}${pathName}`, {
    method,
    headers: { "Content-Type": "application/json" },
    data: data ? JSON.stringify(data) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status(), ok: res.ok(), json };
}

function answerOf(j) {
  const fo = j.finalOutput;
  if (typeof fo === "string") return fo;
  if (fo && typeof fo === "object") {
    return String(fo.answer || fo.summary || fo.shortAnswer || JSON.stringify(fo));
  }
  return String(j.outputSoFar?.summary || "");
}

async function pollAsk(runId, maxMs = 60_000) {
  const start = Date.now();
  let clarified = false;
  let firstProgressMs = null;
  let last = {};
  while (Date.now() - start < maxMs) {
    const r = await api("GET", `/api/ask/${runId}`);
    last = r.json || {};
    const st = String(last.status || "");
    if (!firstProgressMs && st && st !== "PENDING") firstProgressMs = Date.now() - start;
    if (st === "AWAITING_CLARIFICATION" && !clarified) {
      const opts = last.clarificationOptions || [];
      await api("PATCH", "/api/ask", {
        runId,
        selectedOption: opts[0] || "Summarise it into a short brief",
      });
      clarified = true;
    } else if (["COMPLETED", "FAILED", "PARTIAL", "ERROR", "CANCELLED"].includes(st)) {
      return { ...last, firstProgressMs, finalMs: Date.now() - start };
    }
    await page.waitForTimeout(2000);
  }
  return { ...last, firstProgressMs, finalMs: Date.now() - start, timedOut: true };
}

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.getByLabel(/^email$/i).fill(process.env.E2E_EMAIL);
await page.getByLabel(/^password$/i).fill(process.env.E2E_PASSWORD);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60_000 });
await page.evaluate(async (organisationId) => {
  await fetch("/api/session/organisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organisationId }),
  });
}, ORG_QA);

// BP redirect
const bp = await page.request.get(`${BASE}/business-profile`, { maxRedirects: 0 });
out.BP_REDIRECT = {
  status: bp.status(),
  location: bp.headers()["location"] || null,
};

// Contact sort + new contact
const cName = `QA-8A-${Date.now()}`;
const created = await api("POST", "/api/contacts", {
  fullName: cName,
  email: `qa8a-${Date.now()}@example.com`,
});
const list = await api("GET", "/api/contacts");
out.CONTACT = {
  create: created.status,
  first: (list.json?.contacts || [])[0]?.fullName,
  visible: (list.json?.contacts || []).some((c) => c.fullName === cName),
  sort: "lastContactAt_desc,createdAt_desc",
};

const quickQs = [
  { q: "How many open deals do I have in my CRM?", mode: "QUICK", kind: "crm_count" },
  { q: "Summarise my pipeline", mode: "QUICK", kind: "pipeline" },
  { q: "Which of my deals are stuck?", mode: "QUICK", kind: "deal" },
  { q: "How many contacts are in my CRM?", mode: "QUICK", kind: "contact" },
  { q: "What content is awaiting approval?", mode: "QUICK", kind: "content" },
  { q: "What is on my business profile / business context checklist?", mode: "QUICK", kind: "business" },
  { q: "What should I do today?", mode: "QUICK", kind: "priority" },
  { q: "What should I automate from my CRM workload?", mode: "QUICK", kind: "automation" },
  { q: "Tell me about my data.", mode: "QUICK", kind: "ambiguous" },
  { q: "What is a good weekly sales rhythm for a small agency?", mode: "QUICK", kind: "general" },
];

for (const item of quickQs) {
  console.log("QUICK", item.kind);
  const t0 = Date.now();
  const start = await api("POST", "/api/ask", { request: item.q, answerMode: item.mode });
  const runId = start.json?.runId;
  const res = runId ? await pollAsk(runId, 60_000) : {};
  const ans = answerOf(res);
  out.QUICK.push({
    kind: item.kind,
    q: item.q,
    startHttp: start.status,
    status: res.status,
    FIRST_VISIBLE_PROGRESS_MS: res.firstProgressMs ?? null,
    FINAL_RESPONSE_MS: res.finalMs ?? Date.now() - t0,
    MODE: item.mode,
    TOOL_CALL_COUNT: (res.steps || []).filter((s) => s.status === "COMPLETED").length,
    MODEL_CALL_COUNT: null,
    costCents: res.totalCostCents,
    costNote: res.costNote,
    snip: ans.slice(0, 220),
    timedOut: Boolean(res.timedOut),
    clarified: Boolean(res.clarificationQuestion),
  });
}

const opQs = [
  "What should I do today?",
  "Who needs a reply?",
  "Which lead should I focus on?",
  "Which deal is stuck?",
  "What opportunity matters most?",
  "What should I automate?",
  "What content should I create?",
  "Which KPI needs attention?",
  "What should I ignore?",
  "What changed recently that matters?",
];

for (const q of opQs) {
  console.log("OPERATOR", q.slice(0, 40));
  const start = await api("POST", "/api/ask", { request: q, answerMode: "ACTION" });
  const res = start.json?.runId ? await pollAsk(start.json.runId, 60_000) : {};
  const ans = answerOf(res);
  const hasSections = /TOP PRIORITIES|NEEDS ATTENTION|SALES|CONTENT|AUTOMATION|IGNORE/i.test(ans);
  out.OPERATOR.push({
    q,
    status: res.status,
    ms: res.finalMs,
    hasSections,
    snip: ans.slice(0, 400),
    costCents: res.totalCostCents,
    costNote: res.costNote,
  });
}

const prosp = [
  "UK professional-services COOs at firms with 10-50 employees",
  "UK recruitment founders or CEOs at small/midsize firms",
  "UK law or accountancy operations leaders with AI-readiness evidence",
  "UK professional-services decision-makers with clear automation pain",
  "Small-team AI implementation / FDE practitioners in the UK",
];

for (const query of prosp) {
  console.log("PROSPECT", query.slice(0, 50));
  const r = await api("POST", "/api/social-prospecting", { query, limit: 10 });
  const cands = r.json?.candidates || [];
  out.PROSPECTING.push({
    query,
    http: r.status,
    returned: cands.length,
    qualityNote: r.json?.qualityNote,
    sample: cands.slice(0, 5).map((c) => ({
      name: c.personName,
      role: c.role,
      company: c.companyName,
      location: c.location,
      confidence: c.confidence,
      reason: c.reasonSelected,
      qa: c.uncertaintyFlags,
    })),
  });
}

const finals = out.QUICK.map((x) => x.FINAL_RESPONSE_MS).filter((n) => typeof n === "number").sort((a, b) => a - b);
const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor((q / 100) * arr.length))] ?? null;
out.SUMMARY = {
  QUICK_P50_MS: p(finals, 50),
  QUICK_P90_MS: p(finals, 90),
  QUICK_MAX_MS: finals[finals.length - 1] ?? null,
  QUICK_UNDER_25S: out.QUICK.filter((x) => (x.FINAL_RESPONSE_MS || 999999) <= 25_000).length,
  OPERATOR_WITH_SECTIONS: out.OPERATOR.filter((x) => x.hasSections).length,
};

fs.writeFileSync("QA/r8a-benchmark.json", JSON.stringify(out, null, 2));
console.log("WROTE QA/r8a-benchmark.json", JSON.stringify(out.SUMMARY));
await browser.close();
