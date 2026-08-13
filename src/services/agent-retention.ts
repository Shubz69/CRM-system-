import {
  AgentDetailRetention,
  PartialResultsRetention,
  Prisma,
  type OrganisationAgentRetention,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export const DEFAULT_AGENT_RETENTION = {
  toolCallPayloadDays: 14,
  stepFullDetailDays: 30,
  stepSkeletonAfterDays: 180,
  partialResultsFullDays: 30,
} as const;

export const STEPS_CLEARED_MESSAGE =
  "Detailed steps were cleared after 30 days — the brief is saved.";

const PREVIEW_BYTES = 2048;

export type AgentRetentionConfig = {
  toolCallPayloadDays: number;
  stepFullDetailDays: number;
  stepSkeletonAfterDays: number;
  partialResultsFullDays: number;
};

export async function getOrganisationAgentRetention(
  organisationId: string,
): Promise<AgentRetentionConfig> {
  const row = await prisma.organisationAgentRetention.findUnique({
    where: { organisationId },
  });
  if (!row) return { ...DEFAULT_AGENT_RETENTION };
  return {
    toolCallPayloadDays: row.toolCallPayloadDays,
    stepFullDetailDays: row.stepFullDetailDays,
    stepSkeletonAfterDays: row.stepSkeletonAfterDays,
    partialResultsFullDays: row.partialResultsFullDays,
  };
}

export async function setOrganisationAgentRetention(input: {
  organisationId: string;
  toolCallPayloadDays?: number;
  stepFullDetailDays?: number;
  stepSkeletonAfterDays?: number;
  partialResultsFullDays?: number;
}): Promise<OrganisationAgentRetention> {
  const current = await getOrganisationAgentRetention(input.organisationId);
  const data = {
    toolCallPayloadDays: input.toolCallPayloadDays ?? current.toolCallPayloadDays,
    stepFullDetailDays: input.stepFullDetailDays ?? current.stepFullDetailDays,
    stepSkeletonAfterDays: input.stepSkeletonAfterDays ?? current.stepSkeletonAfterDays,
    partialResultsFullDays: input.partialResultsFullDays ?? current.partialResultsFullDays,
  };
  for (const [key, value] of Object.entries(data)) {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`${key} must be a positive integer (days)`);
    }
  }
  if (data.stepSkeletonAfterDays < data.stepFullDetailDays) {
    throw new Error("stepSkeletonAfterDays must be >= stepFullDetailDays");
  }
  return prisma.organisationAgentRetention.upsert({
    where: { organisationId: input.organisationId },
    create: { organisationId: input.organisationId, ...data },
    update: data,
  });
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function previewJson(value: unknown): Prisma.InputJsonValue {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const truncated = raw.length > PREVIEW_BYTES ? `${raw.slice(0, PREVIEW_BYTES)}…` : raw;
  return {
    _retention: "compact",
    preview: truncated,
    originalBytes: Buffer.byteLength(raw, "utf8"),
  };
}

function structuralArgsOnly(value: unknown): Prisma.InputJsonValue {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { _retention: "structural", keys: [] };
  }
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 40);
  const structural: Record<string, unknown> = { _retention: "structural" };
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key];
    if (v == null || typeof v === "boolean" || typeof v === "number") {
      structural[key] = v;
    } else if (typeof v === "string") {
      structural[key] = v.length <= 120 ? v : `${v.slice(0, 120)}…`;
    } else if (Array.isArray(v)) {
      structural[key] = { type: "array", length: v.length };
    } else {
      structural[key] = { type: "object", keys: Object.keys(v as object).slice(0, 20) };
    }
  }
  return structural as Prisma.InputJsonValue;
}

function summarisePartialResults(
  value: unknown,
  stepCount: number,
  totalCostCents: number,
): Prisma.InputJsonValue {
  let hint = "";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.summary === "string") hint = obj.summary.slice(0, 400);
    else if (Array.isArray(obj.steps)) hint = `${obj.steps.length} intermediate step result(s)`;
  }
  return {
    _retention: "summary",
    summary:
      hint ||
      `Intermediate results collapsed after retention window (${stepCount} steps, ${totalCostCents}¢). The brief (finalOutput) is unchanged.`,
    stepCount,
    totalCostCents,
    prunedAt: new Date().toISOString(),
  };
}

export type RetentionSweepResult = {
  organisationId: string;
  toolCallsCleared: number;
  stepsCompacted: number;
  stepsSkeletonised: number;
  partialResultsCollapsed: number;
};

/**
 * Apply retention for one organisation. Idempotent — skips already-pruned rows.
 * Never touches finalOutput.
 */
export async function pruneAgentArtifactsForOrganisation(
  organisationId: string,
): Promise<RetentionSweepResult> {
  const config = await getOrganisationAgentRetention(organisationId);
  const toolCutoff = daysAgo(config.toolCallPayloadDays);
  const stepCompactCutoff = daysAgo(config.stepFullDetailDays);
  const stepSkeletonCutoff = daysAgo(config.stepSkeletonAfterDays);
  const partialCutoff = daysAgo(config.partialResultsFullDays);

  const toolCallsCleared = await prisma.toolCall.updateMany({
    where: {
      organisationId,
      payloadClearedAt: null,
      createdAt: { lt: toolCutoff },
    },
    data: {
      args: {},
      result: Prisma.DbNull,
      payloadClearedAt: new Date(),
    },
  });

  const stepsForSkeleton = await prisma.agentStep.findMany({
    where: {
      organisationId,
      createdAt: { lt: stepSkeletonCutoff },
      detailRetention: { not: AgentDetailRetention.SKELETON },
    },
    select: { id: true },
    take: 500,
  });

  let stepsSkeletonised = 0;
  for (const step of stepsForSkeleton) {
    const updated = await prisma.agentStep.updateMany({
      where: {
        id: step.id,
        organisationId,
        detailRetention: { not: AgentDetailRetention.SKELETON },
      },
      data: {
        input: { _retention: "skeleton" },
        output: Prisma.DbNull,
        detailRetention: AgentDetailRetention.SKELETON,
      },
    });
    stepsSkeletonised += updated.count;
  }

  const stepsForCompact = await prisma.agentStep.findMany({
    where: {
      organisationId,
      createdAt: { lt: stepCompactCutoff },
      detailRetention: AgentDetailRetention.FULL,
    },
    select: { id: true, input: true, output: true },
    take: 500,
  });

  let stepsCompacted = 0;
  for (const step of stepsForCompact) {
    const updated = await prisma.agentStep.updateMany({
      where: {
        id: step.id,
        organisationId,
        detailRetention: AgentDetailRetention.FULL,
      },
      data: {
        input: structuralArgsOnly(step.input),
        output: step.output == null ? Prisma.DbNull : previewJson(step.output),
        detailRetention: AgentDetailRetention.COMPACT,
      },
    });
    stepsCompacted += updated.count;
  }

  const runsForPartial = await prisma.agentRun.findMany({
    where: {
      organisationId,
      createdAt: { lt: partialCutoff },
      partialResultsRetention: PartialResultsRetention.FULL,
      partialResults: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      partialResults: true,
      totalCostCents: true,
      _count: { select: { steps: true } },
    },
    take: 500,
  });

  let partialResultsCollapsed = 0;
  for (const run of runsForPartial) {
    const updated = await prisma.agentRun.updateMany({
      where: {
        id: run.id,
        organisationId,
        partialResultsRetention: PartialResultsRetention.FULL,
      },
      data: {
        partialResults: summarisePartialResults(
          run.partialResults,
          run._count.steps,
          run.totalCostCents,
        ),
        partialResultsRetention: PartialResultsRetention.SUMMARY,
      },
    });
    partialResultsCollapsed += updated.count;
  }

  const result: RetentionSweepResult = {
    organisationId,
    toolCallsCleared: toolCallsCleared.count,
    stepsCompacted,
    stepsSkeletonised,
    partialResultsCollapsed,
  };

  if (
    result.toolCallsCleared ||
    result.stepsCompacted ||
    result.stepsSkeletonised ||
    result.partialResultsCollapsed
  ) {
    logger.info("Agent retention sweep for organisation", result);
  }

  return result;
}

/**
 * Sweep all non-platform orgs. Used by the scheduled BullMQ maintenance job.
 */
export async function pruneAgentArtifactsAllOrganisations(limit = 200): Promise<{
  organisations: number;
  totals: Omit<RetentionSweepResult, "organisationId">;
}> {
  const orgs = await prisma.organisation.findMany({
    where: { deletedAt: null, isPlatform: false },
    select: { id: true },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  const totals = {
    toolCallsCleared: 0,
    stepsCompacted: 0,
    stepsSkeletonised: 0,
    partialResultsCollapsed: 0,
  };

  for (const org of orgs) {
    const r = await pruneAgentArtifactsForOrganisation(org.id);
    totals.toolCallsCleared += r.toolCallsCleared;
    totals.stepsCompacted += r.stepsCompacted;
    totals.stepsSkeletonised += r.stepsSkeletonised;
    totals.partialResultsCollapsed += r.partialResultsCollapsed;
  }

  return { organisations: orgs.length, totals };
}

export type AgentStorageEstimate = {
  organisationId: string;
  runCount: number;
  stepCount: number;
  toolCallCount: number;
  toolCallsWithPayload: number;
  estimatedBytes: {
    runs: number;
    steps: number;
    toolCalls: number;
    total: number;
  };
  estimatedHuman: string;
  retention: AgentRetentionConfig;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Per-org storage estimate for agent artifacts (growth before it becomes a bill).
 */
export async function estimateAgentRunStorage(
  organisationId: string,
): Promise<AgentStorageEstimate> {
  const retention = await getOrganisationAgentRetention(organisationId);

  const rows = await prisma.$queryRaw<
    Array<{
      run_bytes: bigint;
      step_bytes: bigint;
      tool_bytes: bigint;
      run_count: bigint;
      step_count: bigint;
      tool_count: bigint;
      tool_with_payload: bigint;
    }>
  >`
    SELECT
      (SELECT COALESCE(SUM(
          pg_column_size(ar."request")
          + COALESCE(pg_column_size(ar."partialResults"), 0)
          + COALESCE(pg_column_size(ar."finalOutput"), 0)
          + COALESCE(pg_column_size(ar."plan"), 0)
        ), 0)
       FROM "AgentRun" ar WHERE ar."organisationId" = ${organisationId}) AS run_bytes,
      (SELECT COALESCE(SUM(
          pg_column_size(s."input")
          + COALESCE(pg_column_size(s."output"), 0)
          + pg_column_size(s."userFacingLabel")
        ), 0)
       FROM "AgentStep" s WHERE s."organisationId" = ${organisationId}) AS step_bytes,
      (SELECT COALESCE(SUM(
          pg_column_size(t."args")
          + COALESCE(pg_column_size(t."result"), 0)
        ), 0)
       FROM "ToolCall" t WHERE t."organisationId" = ${organisationId}) AS tool_bytes,
      (SELECT COUNT(*)::bigint FROM "AgentRun" WHERE "organisationId" = ${organisationId}) AS run_count,
      (SELECT COUNT(*)::bigint FROM "AgentStep" WHERE "organisationId" = ${organisationId}) AS step_count,
      (SELECT COUNT(*)::bigint FROM "ToolCall" WHERE "organisationId" = ${organisationId}) AS tool_count,
      (SELECT COUNT(*)::bigint FROM "ToolCall"
        WHERE "organisationId" = ${organisationId} AND "payloadClearedAt" IS NULL) AS tool_with_payload
  `;

  const row = rows[0];
  const runs = Number(row?.run_bytes ?? 0);
  const steps = Number(row?.step_bytes ?? 0);
  const toolCalls = Number(row?.tool_bytes ?? 0);
  const total = runs + steps + toolCalls;

  return {
    organisationId,
    runCount: Number(row?.run_count ?? 0),
    stepCount: Number(row?.step_count ?? 0),
    toolCallCount: Number(row?.tool_count ?? 0),
    toolCallsWithPayload: Number(row?.tool_with_payload ?? 0),
    estimatedBytes: { runs, steps, toolCalls, total },
    estimatedHuman: formatBytes(total),
    retention,
  };
}
