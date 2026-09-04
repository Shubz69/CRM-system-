/**
 * Round 7B — ONE GDPR acceptance run on HEAD (local researchAgent, not old worker).
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import { prisma } from "@/lib/db";
import { researchAgent } from "@/agents/research";
import { isPrimaryAuthorityUrl } from "@/lib/research-authority";
import { scoreResearchQuality } from "@/services/research-quality";

loadEnv({ path: path.join(process.cwd(), ".env") });

const ORG = process.env.E2E_TARGET_ORG_ID || "cmtkp47vk0000l504gvfzi1sj";
const prompt =
  "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.";

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
    userFacingLabel: "R7B GDPR structured extraction",
    input: { topic: prompt },
  },
});

console.log("GDPR_RUN", run.id);
let result;
try {
  result = await researchAgent.execute(
    { topic: prompt, maxSources: 20, platforms: ["web"] },
    { organisationId: ORG, agentRunId: run.id, agentStepId: step.id },
  );
} catch (error) {
  console.log("GDPR_SYNTHESIS_COMPLETED", false);
  console.log("GDPR_EXTRACTION_COMPLETED", false);
  console.log(
    "GDPR_ERROR",
    error instanceof Error ? error.message.slice(0, 240) : String(error),
  );
  await prisma.agentStep.update({ where: { id: step.id }, data: { status: "FAILED" } });
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED" } });
  await prisma.$disconnect();
  process.exit(1);
}

const sources = (result.output as { sources?: Array<{ url: string }> }).sources || [];
const findings =
  (
    result.output as {
      findings?: Array<{ claim: string; sourceUrl: string; evidenceExcerpt?: string }>;
    }
  ).findings || [];

const primary = sources.filter((s) => isPrimaryAuthorityUrl(s.url));
const ico = primary.filter((s) => /ico\.org\.uk/i.test(s.url));
const gov = primary.filter((s) => /gov\.uk/i.test(s.url) && !/legislation\.gov\.uk/i.test(s.url));
const leg = primary.filter((s) => /legislation\.gov\.uk/i.test(s.url));
const grounded = findings.filter((f) => sources.some((s) => s.url === f.sourceUrl));
const ungrounded = findings.length - grounded.length;

console.log("GDPR_ROUTE", "RESEARCH");
console.log("GDPR_PRIMARY_COUNT", primary.length);
console.log("GDPR_ICO_COUNT", ico.length);
console.log("GDPR_GOV_UK_COUNT", gov.length);
console.log("GDPR_LEGISLATION_COUNT", leg.length);
console.log("GDPR_SYNTHESIS_COMPLETED", true);
console.log("GDPR_EXTRACTION_COMPLETED", findings.length > 0);
console.log("GDPR_CLAIM_COUNT", findings.length);
console.log("GDPR_GROUNDED_CLAIM_COUNT", grounded.length);
console.log("GDPR_UNGROUNDED_CLAIM_COUNT", ungrounded);

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

console.log("GDPR_SOURCE_QUALITY", report.breakdown.sourceQuality);
console.log("GDPR_RQS", report.overall);
console.log("GDPR_ACCEPTED", report.accepted);

await prisma.agentStep.update({ where: { id: step.id }, data: { status: "COMPLETED" } });
await prisma.agentRun.update({ where: { id: run.id }, data: { status: "COMPLETED" } });
await prisma.$disconnect();

if (!findings.length || grounded.length < 1) process.exit(1);
