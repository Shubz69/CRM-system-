/**
 * Agent framework org-scope integration.
 * Needs real Postgres (DATABASE_URL). Skipped — not silently green — when unset.
 *
 * Creates its own organisations — does not depend on seeded demo data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/agents/supervisor/execute";
import { getAgentRunProgress } from "@/services/agent-runs";
import { ensureAgentsRegistered } from "@/agents";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("agent framework org isolation (Postgres)", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`,
      );
    }
    orgA = await createTestOrganisation("agent-a");
    orgB = await createTestOrganisation("agent-b");
  });

  afterAll(async () => {
    if (orgB) await destroyTestOrganisation(orgB);
    if (orgA) await destroyTestOrganisation(orgA);
    await prisma.$disconnect();
  });

  it("creates AgentRun + AgentSteps scoped to organisation and readable mid-run", async () => {
    ensureAgentsRegistered();
    const run = await prisma.agentRun.create({
      data: {
        organisationId: orgA.organisationId,
        request: 'Echo: "org scope proof"',
        status: "PENDING",
      },
    });

    const result = await executeAgentRun({
      organisationId: orgA.organisationId,
      runId: run.id,
    });
    expect(["COMPLETED", "PARTIAL", "AWAITING_CLARIFICATION"]).toContain(result.status);

    const steps = await prisma.agentStep.findMany({
      where: { organisationId: orgA.organisationId, agentRunId: run.id },
    });
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.every((s) => s.organisationId === orgA.organisationId)).toBe(true);
    expect(steps.every((s) => s.userFacingLabel.trim().length > 0)).toBe(true);

    const progress = await getAgentRunProgress({
      organisationId: orgA.organisationId,
      runId: run.id,
    });
    expect(progress).toBeTruthy();
    expect(progress!.steps.length).toBe(steps.length);
  }, 60_000);

  it("cross-org progress read returns null (not another tenant's data)", async () => {
    const run = await prisma.agentRun.create({
      data: {
        organisationId: orgA.organisationId,
        request: 'Echo: "secret"',
        status: "COMPLETED",
        plainEnglishPlan: "Done.",
        finalOutput: { echo: "secret" },
      },
    });

    const leaked = await getAgentRunProgress({
      organisationId: orgB.organisationId,
      runId: run.id,
    });
    expect(leaked).toBeNull();

    const foreign = await prisma.agentRun.findFirst({
      where: { id: run.id, organisationId: orgB.organisationId },
    });
    expect(foreign).toBeNull();
  }, 30_000);
});
