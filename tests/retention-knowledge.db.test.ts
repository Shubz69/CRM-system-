/**
 * DB integration — agent retention + knowledge retrieval org isolation.
 * Skipped only when DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentDetailRetention } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pruneAgentArtifactsForOrganisation } from "@/services/agent-retention";
import { retrieveRelevantKnowledge, upsertKnowledgeDocument } from "@/services/knowledge";
import { getAgentRunProgress } from "@/services/agent-runs";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("retention + knowledge — DB org isolation", () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("retention prune for org A does not clear org B tool payloads", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Ret A", slug: `ret-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Ret B", slug: `ret-b-${stamp}` },
    });

    const runB = await prisma.agentRun.create({
      data: {
        organisationId: orgB.id,
        request: "research",
        status: "COMPLETED",
        finalOutput: { summary: "Keep me" },
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
    const stepB = await prisma.agentStep.create({
      data: {
        organisationId: orgB.id,
        agentRunId: runB.id,
        position: 0,
        agentName: "echo",
        userFacingLabel: "Echo",
        input: { q: "x" },
        output: { big: "payload".repeat(100) },
        status: "COMPLETED",
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
    const toolB = await prisma.toolCall.create({
      data: {
        organisationId: orgB.id,
        agentStepId: stepB.id,
        toolName: "search",
        args: { query: "secret-b" },
        result: { hits: [1, 2, 3] },
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });

    await pruneAgentArtifactsForOrganisation(orgA.id);

    const untouched = await prisma.toolCall.findUnique({ where: { id: toolB.id } });
    expect(untouched?.payloadClearedAt).toBeNull();
    expect(untouched?.args).toEqual({ query: "secret-b" });

    const progress = await getAgentRunProgress({
      organisationId: orgB.id,
      runId: runB.id,
    });
    expect(progress?.finalOutput).toEqual({ summary: "Keep me" });

    // Cross-org progress must 404-equivalent (null)
    await expect(
      getAgentRunProgress({ organisationId: orgA.id, runId: runB.id }),
    ).resolves.toBeNull();

    await prisma.toolCall.delete({ where: { id: toolB.id } });
    await prisma.agentStep.delete({ where: { id: stepB.id } });
    await prisma.agentRun.delete({ where: { id: runB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });

  it("clears aged tool payloads for the target org and keeps finalOutput", async () => {
    const stamp = Date.now();
    const org = await prisma.organisation.create({
      data: { name: "Ret Keep", slug: `ret-keep-${stamp}` },
    });
    const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const run = await prisma.agentRun.create({
      data: {
        organisationId: org.id,
        request: "research",
        status: "COMPLETED",
        finalOutput: { summary: "Brief forever" },
        partialResults: { steps: [{ huge: true }] },
        createdAt: aged,
      },
    });
    const step = await prisma.agentStep.create({
      data: {
        organisationId: org.id,
        agentRunId: run.id,
        position: 0,
        agentName: "research",
        userFacingLabel: "Research sources",
        input: { sources: 40, query: "full".repeat(200) },
        output: { notes: "full".repeat(400) },
        status: "COMPLETED",
        detailRetention: AgentDetailRetention.FULL,
        createdAt: aged,
      },
    });
    const tool = await prisma.toolCall.create({
      data: {
        organisationId: org.id,
        agentStepId: step.id,
        toolName: "fetch",
        args: { url: "https://example.com" },
        result: { body: "x".repeat(5000) },
        createdAt: aged,
      },
    });

    const result = await pruneAgentArtifactsForOrganisation(org.id);
    expect(result.toolCallsCleared).toBeGreaterThanOrEqual(1);
    expect(result.stepsCompacted).toBeGreaterThanOrEqual(1);

    const clearedTool = await prisma.toolCall.findUnique({ where: { id: tool.id } });
    expect(clearedTool?.payloadClearedAt).not.toBeNull();
    expect(clearedTool?.args).toEqual({});
    expect(clearedTool?.result).toBeNull();

    const kept = await prisma.agentRun.findUnique({ where: { id: run.id } });
    expect(kept?.finalOutput).toEqual({ summary: "Brief forever" });
    expect(kept?.partialResultsRetention).toBe("SUMMARY");

    const progress = await getAgentRunProgress({
      organisationId: org.id,
      runId: run.id,
    });
    expect(progress?.stepsDetailCleared).toBe(true);
    expect(progress?.stepsDetailClearedMessage).toMatch(/brief is saved/i);
    expect(progress?.finalOutput).toEqual({ summary: "Brief forever" });

    await prisma.toolCall.delete({ where: { id: tool.id } });
    await prisma.agentStep.delete({ where: { id: step.id } });
    await prisma.agentRun.delete({ where: { id: run.id } });
    await prisma.organisation.delete({ where: { id: org.id } });
  });

  it("knowledge retrieval never returns another org's chunks", async () => {
    const stamp = Date.now();
    const orgA = await prisma.organisation.create({
      data: { name: "Know A", slug: `know-a-${stamp}` },
    });
    const orgB = await prisma.organisation.create({
      data: { name: "Know B", slug: `know-b-${stamp}` },
    });

    await upsertKnowledgeDocument({
      organisationId: orgA.id,
      title: "Packages A",
      category: "pricing",
      content: "Our investment packages start at 500 pounds per month.",
    });
    await upsertKnowledgeDocument({
      organisationId: orgB.id,
      title: "Secret B",
      category: "pricing",
      content: "TOPSECRET-ORG-B-ONLY pricing code ZZZ999.",
    });

    const hit = await retrieveRelevantKnowledge({
      organisationId: orgA.id,
      query: "how much investment packages",
      limit: 5,
    });

    const blob = hit.chunks.join("\n");
    expect(blob).not.toMatch(/TOPSECRET-ORG-B-ONLY/);
    expect(blob).not.toMatch(/ZZZ999/);

    // Cleanup
    await prisma.knowledgeChunk.deleteMany({ where: { organisationId: orgA.id } });
    await prisma.knowledgeChunk.deleteMany({ where: { organisationId: orgB.id } });
    await prisma.knowledgeDocument.deleteMany({ where: { organisationId: orgA.id } });
    await prisma.knowledgeDocument.deleteMany({ where: { organisationId: orgB.id } });
    await prisma.organisation.delete({ where: { id: orgA.id } });
    await prisma.organisation.delete({ where: { id: orgB.id } });
  });
});
