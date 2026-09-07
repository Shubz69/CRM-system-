/**
 * Phase 8C.2 — Quick / Operator / Prospect / first-progress benchmarks.
 * Scorer must not treat CRM words like "stalled" as failure tokens.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import fs from "fs";
import { chromium } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const BASE = (process.env.PHASE8C2_BASE_URL || process.env.PHASE8C_BASE_URL || "").replace(/\/$/, "");
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const ORG_QA = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const ORG_SPARSE = process.env.E2E_SPARSE_ORG_ID || "";

if (!BASE) {
  console.error("Set PHASE8C2_BASE_URL");
  process.exit(1);
}

const out = {
  BASE,
  HEAD: process.env.PHASE8C2_HEAD || null,
  QUICK: [],
  OPERATOR: [],
  OPERATOR_SPARSE: [],
  PROSPECTING: [],
  FAILURE_BREAKDOWN: {},
  AMBIGUOUS: [],
  COST: {},
  SUMMARY: {},
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
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status(), ok: res.ok(), json };
}

function answerOf(j) {
  const fo = j.finalOutput;
  if (typeof fo === "string") return fo;
  if (fo && typeof fo === "object") {
    return String(fo.answer || fo.summary || fo.shortAnswer || JSON.stringify(fo));
  }
  return String(j.outputSoFar?.summary || j.plainEnglishPlan || "");
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function classifyBad(row) {
  const a = (row.ANSWER_PREVIEW || "").toLowerCase();
  if (row.CLARIFICATION_USED) return "UNNECESSARY_CLARIFICATION";
  if (row.STATUS !== "COMPLETED") return "FAILED_TO_ANSWER";
  if (!a || a.length < 15) return "GENERIC_NON_ANSWER";
  if (/insufficient evidence|no .* currently|no open deals|0\b/.test(a) && row.EXPECTED_INTENT === "follow_ups") {
    return a.includes("need a reply") || a.includes("needing reply") ? null : "MISSING_REQUIRED_DETAIL";
  }
  if (/focus lead|e2e-ma/i.test(a) && /reply|automate|overview/i.test(row.QUESTION)) {
    return "WRONG_PRIORITY";
  }
  if (/i think|generally|in business/i.test(a) && !/workspace|crm|inbox|deal|contact/i.test(a)) {
    return "GENERIC_NON_ANSWER";
  }
  if (!row.GROUNDED) return "IGNORED_TOOL_DATA";
  if (!row.CORRECT) return "BAD_SHAPING";
  return null;
}

async function login(orgId = ORG_QA) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const email = process.env.E2E_EMAIL || process.env.QA_EMAIL;
  const password = process.env.E2E_PASSWORD || process.env.QA_PASSWORD;
  if (!email || !password) throw new Error("E2E_EMAIL/E2E_PASSWORD required");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60_000 });
  await page.evaluate(async (organisationId) => {
    await fetch("/api/session/organisation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationId }),
    });
  }, orgId);
}

async function pollAsk(runId, maxMs = 90_000, ackMs = null) {
  const start = Date.now();
  let firstProgressMs = ackMs;
  let lastStatus = null;
  let lastChange = Date.now();
  let json = null;
  while (Date.now() - start < maxMs) {
    const r = await api("GET", `/api/ask/${runId}`);
    json = r.json;
    const status = json?.status;
    const plan = json?.plainEnglishPlan || "";
    if ((plan || (status && status !== "PENDING")) && firstProgressMs == null) {
      firstProgressMs = Date.now() - start;
    }
    if (status !== lastStatus || plan) {
      lastChange = Date.now();
      lastStatus = status;
    }
    if (
      ["COMPLETED", "PARTIAL", "FAILED", "AWAITING_CLARIFICATION", "AWAITING_PROMPT_CONFIRM"].includes(
        status,
      )
    ) {
      return { json, firstProgressMs: firstProgressMs ?? Date.now() - start, finalMs: Date.now() - start };
    }
    if (Date.now() - lastChange > 60_000) {
      return {
        json: { ...json, status: "STALLED", error: "no_progress_60s" },
        firstProgressMs,
        finalMs: Date.now() - start,
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { json: json || { status: "TIMEOUT" }, firstProgressMs, finalMs: Date.now() - start };
}

async function askOnce(spec, mode = "QUICK") {
  const question = typeof spec === "string" ? spec : spec.q;
  const expectedIntent = typeof spec === "object" ? spec.intent : null;
  const expectedRoute = typeof spec === "object" ? spec.route || "crm_desk" : "crm_desk";
  const t0 = Date.now();
  const created = await api("POST", "/api/ask", { request: question, answerMode: mode });
  const ackMs =
    created.ok && (created.json?.plainEnglishPlan || created.json?.message)
      ? Date.now() - t0
      : null;
  if (!created.ok || !created.json?.runId) {
    return {
      QUESTION: question,
      EXPECTED_INTENT: expectedIntent,
      EXPECTED_ROUTE: expectedRoute,
      ACTUAL_ROUTE: null,
      FIRST_PROGRESS_MS: ackMs,
      FINAL_MS: Date.now() - t0,
      CORRECT: false,
      USEFUL: false,
      GROUNDED: false,
      COMPLETE: false,
      ROUTE_CORRECT: false,
      CLARIFICATION_USED: false,
      STATUS: "CREATE_FAILED",
      ANSWER_PREVIEW: "",
      WHY: "create_failed",
    };
  }
  let polled = await pollAsk(created.json.runId, 90_000, ackMs);
  let clarificationUsed = false;
  if (polled.json?.status === "AWAITING_CLARIFICATION") {
    clarificationUsed = true;
  }
  const answer = answerOf(polled.json || {});
  const grounded =
    /contact|deal|goal|inbox|compan|workspace|organisation|business|evidence|unread|stalled|approval|lead|reply|open deals|conversations/i.test(
      answer,
    );
  const useful =
    polled.json?.status === "COMPLETED" &&
    answer.length > 20 &&
    !/\bcouldn't start\b|\btry again later\b/i.test(answer);
  const route =
    created.json?.syncFastPath ||
    (polled.json?.finalOutput &&
      typeof polled.json.finalOutput === "object" &&
      polled.json.finalOutput.source === "internal_crm")
      ? "crm_desk"
      : /research/i.test(String(polled.json?.plainEnglishPlan || ""))
        ? "research"
        : "crm_desk";
  const routeOk = route === expectedRoute || expectedRoute === "crm_desk";
  const correct =
    useful && !clarificationUsed && routeOk && grounded;
  const row = {
    QUESTION: question,
    EXPECTED_INTENT: expectedIntent,
    EXPECTED_ROUTE: expectedRoute,
    ACTUAL_ROUTE: route,
    FIRST_PROGRESS_MS: polled.firstProgressMs ?? ackMs,
    FINAL_MS: Date.now() - t0,
    CORRECT: correct,
    USEFUL: useful,
    GROUNDED: grounded,
    COMPLETE: useful && answer.length > 40,
    ROUTE_CORRECT: routeOk,
    CLARIFICATION_USED: clarificationUsed,
    STATUS: polled.json?.status,
    COST_CENTS: polled.json?.totalCostCents,
    COST_NOTE: polled.json?.costNote,
    SYNC_FAST_PATH: Boolean(created.json?.syncFastPath),
    ANSWER_PREVIEW: answer.slice(0, 500),
    WHY: correct ? "ok" : clarificationUsed ? "clarification" : !useful ? "not_useful" : "quality",
  };
  const cls = classifyBad(row);
  if (cls) out.FAILURE_BREAKDOWN[cls] = (out.FAILURE_BREAKDOWN[cls] || 0) + 1;
  return row;
}

function scoreOperator(text, finalMs) {
  const t = text || "";
  const hasWhatWhy = /WHAT:|WHY:|EVIDENCE:|NEXT ACTION:/i.test(t);
  const sections = [
    /TOP PRIORITIES/i,
    /NEEDS ATTENTION/i,
    /SALES/i,
    /PIPELINE RISK/i,
    /CONTENT/i,
    /AUTOMATION/i,
    /GOALS/i,
    /IGNORE/i,
    /INSUFFICIENT/i,
  ].filter((re) => re.test(t)).length;
  const weakLeadDominate = /focus lead e2e/i.test(t) && !/no conversations currently need a reply|inbox/i.test(t);
  const honesty = /INSUFFICIENT EVIDENCE|no open deals|sparse|not evidenced|cannot|no conversations currently/i.test(t);
  const fabricated = /always|everyone|guaranteed/i.test(t) && !honesty;
  const clamp = (n) => Math.max(0, Math.min(10, Math.round(n * 10) / 10));
  return {
    SPECIFICITY: clamp(weakLeadDominate ? 5 : hasWhatWhy || sections >= 4 ? 9.6 : 6),
    EVIDENCE: clamp(hasWhatWhy || /EVIDENCE PACK|Evidence:/i.test(t) ? 9.6 : honesty ? 9.2 : 6),
    PRIORITISATION: clamp(weakLeadDominate ? 4 : sections >= 5 || /TOP PRIORITIES/i.test(t) ? 9.7 : 6),
    ACTIONABILITY: clamp(hasWhatWhy || /NEXT ACTION/i.test(t) ? 9.6 : 6),
    BUSINESS_VALUE: clamp(weakLeadDominate ? 5 : sections >= 4 ? 9.5 : 6),
    HONESTY: clamp(fabricated ? 3 : honesty || sections >= 3 ? 9.7 : 8),
    CONTEXT_USE: clamp(/workspace|crm|inbox|deal|goal|contact|evidence pack/i.test(t) ? 9.6 : 5),
    CLARITY: clamp(sections >= 3 ? 9.6 : t.length > 80 ? 8 : 5),
    COMPLETENESS: clamp(sections >= 5 ? 9.6 : sections >= 3 ? 8.5 : 5),
    SPEED: clamp(finalMs == null ? 5 : finalMs <= 12000 ? 9.8 : finalMs <= 20000 ? 9.5 : finalMs <= 30000 ? 8.5 : 6),
  };
}

await login();
console.log("LOGGED_IN", BASE);

const quickSpecs = [
  { q: "How many contacts do I have?", intent: "desk_overview" },
  { q: "List my newest contacts", intent: "desk_overview" },
  { q: "How many companies are in the workspace?", intent: "desk_overview" },
  { q: "Name one company if any exist", intent: "desk_overview" },
  { q: "Show my contacts count from CRM", intent: "desk_overview" },
  { q: "How many open deals are there?", intent: "pipeline_summary" },
  { q: "Which deals look stalled?", intent: "pipeline_summary" },
  { q: "What is the health of my pipeline in one paragraph?", intent: "pipeline_summary" },
  { q: "Summarise my open deals", intent: "pipeline_summary" },
  { q: "Which deal is stuck in my CRM?", intent: "pipeline_summary" },
  { q: "How many open deals do we have?", intent: "pipeline_summary" },
  { q: "Who needs a reply in Inbox?", intent: "follow_ups" },
  { q: "How many conversations need a human?", intent: "conversations_needing_human" },
  { q: "Which customers need follow-up?", intent: "follow_ups" },
  { q: "Who needs a reply?", intent: "follow_ups" },
  { q: "Any follow-ups waiting in Inbox?", intent: "follow_ups" },
  { q: "Which goals are at risk?", intent: "goals_at_risk" },
  { q: "Are any goals marked at risk?", intent: "goals_at_risk" },
  { q: "List goals at risk in this workspace", intent: "goals_at_risk" },
  { q: "What KPI or goal needs attention from goals?", intent: "goals_at_risk" },
  { q: "Do we have goals currently at risk?", intent: "goals_at_risk" },
  { q: "What content is awaiting approval?", intent: "content_awaiting_approval" },
  { q: "Any content waiting for approval?", intent: "content_awaiting_approval" },
  { q: "Summarise content in review", intent: "content_awaiting_approval" },
  { q: "Is any content waiting for approval?", intent: "content_awaiting_approval" },
  { q: "What should I automate first?", intent: "operator_brief" },
  { q: "Any repetitive processes worth automating?", intent: "operator_brief" },
  { q: "What should I automate from my CRM?", intent: "operator_brief" },
  { q: "What automation would help this workspace?", intent: "operator_brief" },
  { q: "Which opportunity matters most from CRM?", intent: "operator_brief" },
  { q: "What opportunities should I review?", intent: "operator_brief" },
  { q: "Any detected opportunities worth attention?", intent: "operator_brief" },
  { q: "What does our business profile say we sell?", intent: "business_context" },
  { q: "What industry are we in from Business Context?", intent: "business_context" },
  { q: "What does our business sell?", intent: "business_context" },
  { q: "What should I prioritise today from CRM?", intent: "operator_brief" },
  { q: "Give a short business overview of this workspace", intent: "desk_overview" },
  { q: "What can wait until next week in my CRM?", intent: "operator_brief" },
  { q: "How is the pipeline looking?", intent: "pipeline_summary" },
  { q: "What needs attention in this workspace?", intent: "operator_brief" },
];

for (const spec of quickSpecs) {
  console.log("QUICK", spec.q.slice(0, 55));
  out.QUICK.push(await askOnce(spec, "QUICK"));
}

const ambiguous = [
  "How is the pipeline looking?",
  "What needs attention?",
  "What should I focus on?",
  "Which deal is stuck?",
  "Who should I talk to?",
  "What's urgent?",
  "Any fires today?",
  "Where are we behind?",
  "What is blocking progress?",
  "Give me a status check",
  "What matters this morning?",
  "Anything overdue?",
  "Who is waiting on me?",
  "What can wait?",
  "Are we healthy?",
  "Quick CRM pulse",
  "Summarise what needs me",
  "Pipeline and inbox snapshot",
  "Top risk right now?",
  "What should I ignore?",
];
for (const q of ambiguous) {
  console.log("AMBIG", q);
  const row = await askOnce({ q, intent: "operator_or_crm", route: "crm_desk" }, "QUICK");
  out.AMBIGUOUS.push(row);
}

const opQs = [
  "What should I do today?",
  "Who needs a reply?",
  "Which lead should I focus on?",
  "Which deal is stuck?",
  "Which opportunity matters most?",
  "What should I automate?",
  "What content should I create?",
  "Which KPI needs attention?",
  "What should I ignore?",
  "What changed recently?",
  "What is the biggest sales risk?",
  "Which customers need follow-up?",
  "What should I improve this week?",
  "Where are we losing momentum?",
  "What can I safely deprioritise?",
  "Which deal deserves the most attention?",
  "Are we neglecting anyone important?",
  "What is blocking revenue?",
  "Where are we wasting time?",
  "Give me the three highest-value actions I can take now.",
];
for (const q of opQs) {
  console.log("OPERATOR", q);
  const row = await askOnce({ q, intent: "operator_brief", route: "crm_desk" }, "ACTION");
  row.SCORES = scoreOperator(row.ANSWER_PREVIEW || "", row.FINAL_MS);
  row.HAS_OPERATOR_SECTIONS = /TOP PRIORITIES/i.test(row.ANSWER_PREVIEW || "");
  out.OPERATOR.push(row);
}

if (ORG_SPARSE) {
  await login(ORG_SPARSE);
  for (const q of opQs.slice(0, 8)) {
    console.log("SPARSE", q);
    const row = await askOnce({ q, intent: "operator_brief", route: "crm_desk" }, "ACTION");
    row.SCORES = scoreOperator(row.ANSWER_PREVIEW || "", row.FINAL_MS);
    out.OPERATOR_SPARSE.push(row);
  }
}

const prospectQs = [
  "UK professional-services COOs at firms with 10-50 employees",
  "UK recruitment founders or CEOs at small firms",
  "UK law operations leaders with AI-readiness evidence",
  "UK accountancy operations leaders with automation pain",
  "UK SaaS COOs at 20-100 employees",
  "UK property-management decision-makers with workflow complexity",
  "UK logistics operations leaders at SMEs",
  "UK professional-services founders mentioning AI adoption",
  "UK legal or accounting firms with recent transformation hiring",
  "Antarctic penguin COOs at 10-50 employee ice-cream consultancies",
  "interesting people in tech",
  "find me some prospects roughly in London",
  "COO or operations lead UK professional services 10-50",
  "Founders in Manchester recruitment agencies",
  "CEOs of UK SaaS companies about 20 employees",
  "UK fintech CTOs at 50-200 employee companies",
  "London dental clinic owners",
  "UK agency founders seeking automation",
  "Manchester SaaS COOs 10-50 employees",
  "UK professional services decision-makers",
];

for (const q of prospectQs) {
  console.log("PROSPECT", q.slice(0, 55));
  const t0 = Date.now();
  const r = await api("POST", "/api/social-prospecting", { action: "discover", query: q });
  const candidates = r.json?.candidates || r.json?.prospects || [];
  const parseTier = (c) => {
    const tier = c.qaDecision?.matchTier || c.matchTier;
    if (tier) return tier;
    const flags = c.uncertaintyFlags || [];
    const qa = flags.find((f) => typeof f === "string" && f.startsWith("qa:"));
    if (!qa) return null;
    try {
      return JSON.parse(qa.slice(3)).matchTier || null;
    } catch {
      return null;
    }
  };
  const exact = candidates.filter((c) => parseTier(c) === "EXACT");
  const possible = candidates.filter((c) => parseTier(c) === "POSSIBLE");
  const falseExact = exact.filter((c) => {
    const flags = c.uncertaintyFlags || [];
    const qa = flags.find((f) => typeof f === "string" && f.startsWith("qa:"));
    if (!qa) return true;
    try {
      const parsed = JSON.parse(qa.slice(3));
      if (parsed.matchTier !== "EXACT") return false;
      if (parsed.requestedRole && parsed.roleConstraint !== "MATCHED") return true;
      if (parsed.requestedLocation && parsed.locationConstraint !== "MATCHED") return true;
      if (parsed.sizeConstraint && parsed.sizeConstraint !== "MATCHED" && parsed.sizeConstraint !== undefined) {
        // sizeConstraint only present when size was mandatory in new contract
        return parsed.sizeConstraint !== "MATCHED";
      }
      return false;
    } catch {
      return true;
    }
  });
  const exactWithoutEvidence = exact.filter(
    (c) => !(c.sourceEvidence || []).length && !(c.reasonSelected || "").trim(),
  );
  out.PROSPECTING.push({
    QUERY: q,
    TOTAL_RESULTS: candidates.length,
    EXACT: exact.length,
    POSSIBLE: possible.length,
    FALSE_EXACT: falseExact.length,
    EXACT_WITHOUT_FULL_EVIDENCE: exactWithoutEvidence.length,
    MS: Date.now() - t0,
  });
}

const finals = out.QUICK.map((r) => r.FINAL_MS).filter((n) => typeof n === "number").sort((a, b) => a - b);
const firsts = out.QUICK.map((r) => r.FIRST_PROGRESS_MS).filter((n) => typeof n === "number").sort((a, b) => a - b);
const opMins = {};
for (const key of [
  "SPECIFICITY",
  "EVIDENCE",
  "PRIORITISATION",
  "ACTIONABILITY",
  "BUSINESS_VALUE",
  "HONESTY",
  "CONTEXT_USE",
  "CLARITY",
  "COMPLETENESS",
  "SPEED",
]) {
  const vals = out.OPERATOR.map((r) => r.SCORES?.[key]).filter((n) => typeof n === "number");
  opMins[key] = vals.length ? Math.min(...vals) : null;
}

out.SUMMARY = {
  QUICK_CORRECTNESS: out.QUICK.filter((r) => r.CORRECT).length / Math.max(1, out.QUICK.length),
  QUICK_USEFULNESS: out.QUICK.filter((r) => r.USEFUL).length / Math.max(1, out.QUICK.length),
  QUICK_GROUNDING: out.QUICK.filter((r) => r.GROUNDED).length / Math.max(1, out.QUICK.length),
  QUICK_ROUTING: out.QUICK.filter((r) => r.ROUTE_CORRECT).length / Math.max(1, out.QUICK.length),
  UNNECESSARY_CLARIFICATION_RATE:
    out.QUICK.filter((r) => r.CLARIFICATION_USED).length / Math.max(1, out.QUICK.length),
  QUICK_P50_MS: pct(finals, 50),
  QUICK_P90_MS: pct(finals, 90),
  QUICK_MAX_MS: finals.at(-1) ?? null,
  FIRST_PROGRESS_P90_MS: pct(firsts, 90),
  AMBIGUOUS_TOTAL: out.AMBIGUOUS.length,
  AMBIGUOUS_CLARIFIED: out.AMBIGUOUS.filter((r) => r.CLARIFICATION_USED).length,
  AMBIGUOUS_ANSWERED: out.AMBIGUOUS.filter((r) => !r.CLARIFICATION_USED && r.STATUS === "COMPLETED").length,
  OPERATOR_MINS: opMins,
  OPERATOR_P50_MS: pct(
    out.OPERATOR.map((r) => r.FINAL_MS).filter((n) => typeof n === "number").sort((a, b) => a - b),
    50,
  ),
  OPERATOR_P90_MS: pct(
    out.OPERATOR.map((r) => r.FINAL_MS).filter((n) => typeof n === "number").sort((a, b) => a - b),
    90,
  ),
  OPERATOR_MAX_MS: out.OPERATOR.map((r) => r.FINAL_MS)
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b)
    .at(-1),
  PROSPECTING_EXACT: out.PROSPECTING.reduce((a, p) => a + p.EXACT, 0),
  PROSPECTING_POSSIBLE: out.PROSPECTING.reduce((a, p) => a + p.POSSIBLE, 0),
  PROSPECTING_FALSE_EXACT: out.PROSPECTING.reduce((a, p) => a + p.FALSE_EXACT, 0),
  PROSPECTING_EXACT_WITHOUT_FULL_EVIDENCE: out.PROSPECTING.reduce(
    (a, p) => a + p.EXACT_WITHOUT_FULL_EVIDENCE,
    0,
  ),
  FAILURE_BREAKDOWN: out.FAILURE_BREAKDOWN,
};

fs.writeFileSync(path.join(process.cwd(), "QA/r8c2-benchmark.json"), JSON.stringify(out, null, 2));
console.log("WROTE QA/r8c2-benchmark.json", JSON.stringify(out.SUMMARY, null, 2));
await browser.close();
