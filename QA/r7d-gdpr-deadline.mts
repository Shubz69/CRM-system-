/**
 * Round 7D — ONE worker-backed GDPR run proving RQS attaches before optional enrichment
 * can starve it (supervisor executeAgentRun path).
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/agents/supervisor/execute";
import { extractCanonicalGroundedClaims, countLinkedGroundedClaims } from "@/services/research-quality";

loadEnv({ path: path.join(process.cwd(), ".env") });

const ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const prompt =
  "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.";

const t0 = Date.now();
const heartbeat = setInterval(() => {
  console.log("WORKER_GDPR_HEARTBEAT", new Date().toISOString(), `elapsedMs=${Date.now() - t0}`);
}, 45_000);

const run = await prisma.agentRun.create({
  data: {
    organisationId: ORG,
    request: prompt,
    status: "PENDING",
    answerMode: "DEEP",
    maxWallClockSeconds: 600,
    maxSteps: 8,
    plan: {
      steps: [
        { agentName: "research", input: { topic: prompt } },
        { agentName: "analyst", input: { topic: prompt } },
        { agentName: "critic", input: {} },
      ],
      plainEnglishPlan:
        "I'll research sourced facts, attach quality, then enrich if time remains.",
    },
    plainEnglishPlan:
      "I'll research sourced facts, attach quality, then enrich if time remains.",
  },
});

console.log("WORKER_GDPR_RUN", run.id);

let result;
try {
  result = await executeAgentRun({ organisationId: ORG, runId: run.id });
} catch (error) {
  clearInterval(heartbeat);
  console.log(
    "WORKER_GDPR_ERROR",
    error instanceof Error ? error.message.slice(0, 400) : String(error),
  );
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "FAILED", error: String(error).slice(0, 500) },
  });
  await prisma.$disconnect();
  process.exit(1);
}
clearInterval(heartbeat);

const fo = (result.finalOutput || {}) as Record<string, unknown>;
const rq = (fo.researchQuality || null) as Record<string, unknown> | null;
const findings = Array.isArray(fo.findings)
  ? fo.findings
  : Array.isArray(fo.claims)
    ? fo.claims
    : [];
const sources = Array.isArray(fo.sources) ? fo.sources : [];
const grounded = extractCanonicalGroundedClaims(fo, {
  allowedSourceUrls: sources
    .map((s) => (s && typeof s === "object" ? String((s as { url?: string }).url || "") : ""))
    .filter(Boolean),
});
const linked = countLinkedGroundedClaims(grounded);

const steps = await prisma.agentStep.findMany({
  where: { agentRunId: run.id, organisationId: ORG },
  orderBy: { position: "asc" },
  select: {
    position: true,
    agentName: true,
    status: true,
    durationMs: true,
    userFacingLabel: true,
  },
});

const researchStep = steps.find((s) => s.agentName === "research");
const analystStep = steps.find((s) => s.agentName === "analyst");
const rqsAttachedAtMs =
  researchStep?.status === "COMPLETED" && rq
    ? (researchStep.durationMs ?? null)
    : rq
      ? Date.now() - t0
      : null;

const failureState =
  result.status === "PARTIAL" && rq
    ? "PARTIAL_WITH_GROUNDED_QUALITY"
    : result.status === "PARTIAL" && !rq
      ? "PARTIAL_TIMEOUT_BEFORE_RQS_ATTACH"
      : fo.phase
        ? String(fo.phase)
        : result.status === "COMPLETED"
          ? "NONE"
          : String(result.status);

console.log("WORKER_FINDINGS", findings.length);
console.log("WORKER_GROUNDED", grounded.length);
console.log("WORKER_RQS_INPUT_CLAIMS", linked);
console.log(
  "WORKER_CLAIM_CONFIDENCES",
  Array.isArray(rq?.claimConfidences) ? (rq!.claimConfidences as unknown[]).length : 0,
);
console.log("WORKER_SOURCE_QUALITY", rq?.breakdown ? (rq.breakdown as { sourceQuality?: number }).sourceQuality : null);
console.log("WORKER_RQS", rq?.overall ?? null);
console.log("WORKER_ACCEPTED", rq?.accepted ?? null);
console.log("WORKER_FAILURE_STATE", failureState);
console.log("WORKER_TOTAL_RUNTIME_MS", Date.now() - t0);
console.log("WORKER_RQS_ATTACHED_AT_MS", rqsAttachedAtMs);
console.log(
  "WORKER_ANALYST_RESULT",
  analystStep
    ? `${analystStep.status}${fo.analystEnrichmentSkipped ? "+SKIPPED_BUDGET" : ""}${fo.analystEnrichmentFailed ? "+ENRICHMENT_FAILED" : ""}`
    : "MISSING",
);
console.log("WORKER_RUN_STATUS", result.status);
console.log("WORKER_HAS_RQS", Boolean(rq));
console.log("WORKER_STEPS", JSON.stringify(steps));

await prisma.$disconnect();
process.exit(rq && grounded.length > 0 && linked > 0 ? 0 : 1);
