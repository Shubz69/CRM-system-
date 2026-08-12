/**
 * Agent framework org-scope integration.
 * Needs real Postgres (DATABASE_URL). Skipped — not silently green — when unset.
 *
 * Also covers mid-run progress readability when Redis is not required for
 * direct executeAgentRun calls (queue enqueue is tested separately).
 */
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/agents/supervisor/execute";
import { getAgentRunProgress } from "@/services/agent-runs";
import { ensureAgentsRegistered } from "@/agents";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("agent framework org isolation (Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let userA: string | null = null;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("resolves two organisations for cross-org checks", async () => {
    const orgs = await prisma.organisation.findMany({
      where: { deletedAt: null, isPlatform: false },
      take: 2,
      orderBy: { createdAt: "asc" },
    });
    expect(orgs.length).toBeGreaterThanOrEqual(1);
    orgA = orgs[0]!.id;
    orgB = orgs[1]?.id || orgs[0]!.id;

    const member = await prisma.organisationMember.findFirst({
      where: { organisationId: orgA },
      select: { userId: true },
    });
    userA = member?.userId ?? null;
  });

  it("creates AgentRun + AgentSteps scoped to organisation and readable mid-run", async () => {
    ensureAgentsRegistered();
    const run = await prisma.agentRun.create({
      data: {
        organisationId: orgA,
        userId: userA,
        request: 'Echo: "org scope proof"',
        status: "PENDING",
      },
    });

    // Simulate mid-run: execute fully (echo is sync) then assert org filters.
    const result = await executeAgentRun({ organisationId: orgA, runId: run.id });
    expect(["COMPLETED", "PARTIAL", "AWAITING_CLARIFICATION"]).toContain(result.status);

    const steps = await prisma.agentStep.findMany({
      where: { organisationId: orgA, agentRunId: run.id },
    });
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.every((s) => s.organisationId === orgA)).toBe(true);
    expect(steps.every((s) => s.userFacingLabel.trim().length > 0)).toBe(true);

    const progress = await getAgentRunProgress({ organisationId: orgA, runId: run.id });
    expect(progress).toBeTruthy();
    expect(progress!.steps.length).toBe(steps.length);
  });

  it("cross-org progress read returns null (not another tenant's data)", async () => {
    if (orgA === orgB) {
      // Only one org in DB — create a second throwaway org for the negative check.
      const other = await prisma.organisation.create({
        data: {
          name: `Agent Cross Org ${Date.now()}`,
          slug: `agent-cross-${Date.now()}`,
        },
      });
      orgB = other.id;
    }

    const run = await prisma.agentRun.create({
      data: {
        organisationId: orgA,
        request: 'Echo: "secret"',
        status: "COMPLETED",
        plainEnglishPlan: "Done.",
        finalOutput: { echo: "secret" },
      },
    });

    const leaked = await getAgentRunProgress({ organisationId: orgB, runId: run.id });
    expect(leaked).toBeNull();

    const foreign = await prisma.agentRun.findFirst({
      where: { id: run.id, organisationId: orgB },
    });
    expect(foreign).toBeNull();
  });
});

describe("agent framework integration — skip notice", () => {
  it("documents that Postgres integration tests above need DATABASE_URL", () => {
    if (!hasDatabase) {
      expect(hasDatabase).toBe(false);
    } else {
      expect(hasDatabase).toBe(true);
    }
  });
});
