/**
 * Round 7B — one worker-backed (local HEAD) research pipeline check.
 * Verifies synthesis + structured extraction + claims + grounding + RQS.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@/lib/db";
import { researchAgent } from "@/agents/research";
import { scoreResearchQuality } from "@/services/research-quality";

loadEnv({ path: path.join(process.cwd(), ".env") });

const ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const prompt =
  "Summarise current UK ICO guidance on securing customer personal data stored in a CRM. Prefer ico.org.uk primary sources.";

const run = await prisma.agentRun.create({
  data: {
    organisationId: ORG,
    request: prompt,
    status: "RUNNING",
    answerMode: "DEEP",
  },
});
const step = await prisma.agentStep.create({
  data: {
    agentRunId: run.id,
    organisationId: ORG,
    position: 0,
    agentName: "research",
    status: "RUNNING",
    userFacingLabel: "R7B structured extraction smoke",
    input: { topic: prompt },
  },
});

console.log("WORKER_TEST_RUN", run.id);
let result;
try {
  result = await researchAgent.execute(
    { topic: prompt, maxSources: 12, platforms: ["web"] },
    { organisationId: ORG, agentRunId: run.id, agentStepId: step.id },
  );
} catch (error) {
  console.log("WORKER_TEST_SYNTHESIS", "FAIL");
  console.log("WORKER_TEST_EXTRACTION", "FAIL");
  console.log(
    "WORKER_TEST_ERROR",
    error instanceof Error ? error.message.slice(0, 200) : String(error),
  );
  await prisma.agentStep.update({
    where: { id: step.id },
    data: { status: "FAILED" },
  });
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "FAILED" },
  });
  await prisma.$disconnect();
  process.exit(1);
}

const output = result.output as {
  findings?: Array<{ claim: string; sourceUrl: string; evidenceExcerpt?: string }>;
  sources?: Array<{ url: string }>;
  summary?: string;
};
const findings = output.findings || [];
const sources = output.sources || [];

console.log("WORKER_TEST_SYNTHESIS", findings.length > 0 || sources.length > 0 ? "PASS" : "FAIL");
console.log("WORKER_TEST_EXTRACTION", findings.length > 0 ? "PASS" : "FAIL");
console.log("WORKER_TEST_CLAIM_COUNT", findings.length);

const report = scoreResearchQuality({
  originalUserPrompt: prompt,
  researchTopic: prompt,
  claims: findings.map((f) => ({
    claim: f.claim,
    sourceUrl: f.sourceUrl,
    evidenceExcerpt: f.evidenceExcerpt || f.claim.slice(0, 120),
    claimKind: "OFFICIAL" as const,
    confidence: 0.7,
  })),
  sources: sources.map((s) => ({
    url: s.url,
    title: s.url,
    platform: "web",
    publishedAt: new Date().toISOString(),
    freshnessScore: 0.8,
  })),
});

const grounded = findings.filter((f) => sources.some((s) => s.url === f.sourceUrl));
console.log("WORKER_TEST_GROUNDED_CLAIM_COUNT", grounded.length);
console.log("WORKER_TEST_RQS", report.overall);
console.log("WORKER_TEST_SOURCE_QUALITY", report.breakdown.sourceQuality);
console.log("WORKER_TEST_ACCEPTED", report.accepted);

await prisma.agentStep.update({
  where: { id: step.id },
  data: { status: "COMPLETED" },
});
await prisma.agentRun.update({
  where: { id: run.id },
  data: { status: "COMPLETED" },
});
await prisma.$disconnect();

if (findings.length < 1 || grounded.length < 1) process.exit(1);
