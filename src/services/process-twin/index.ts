import { prisma } from "@/lib/db";

export const processTwinEnabled = true;

export const BUILTIN_PROCESSES = [
  {
    processKey: "lead_funnel",
    label: "Lead funnel",
    stages: ["NEW", "QUALIFIED", "CONTACTED", "CONVERTED", "DISQUALIFIED"],
  },
  {
    processKey: "deal_funnel",
    label: "Deal funnel",
    stages: ["OPEN", "DISCOVERY", "PROPOSAL", "NEGOTIATION", "WON", "LOST"],
  },
  {
    processKey: "content_lifecycle",
    label: "Content lifecycle",
    stages: ["IDEA", "DRAFT", "REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"],
  },
  {
    processKey: "opportunity_mission",
    label: "Opportunity mission",
    stages: ["DETECTED", "PLANNED", "RUNNING", "COMPLETED", "DISMISSED"],
  },
  {
    processKey: "publishing",
    label: "Publishing",
    stages: ["QUEUED", "VALIDATING", "DISPATCHING", "PUBLISHED", "FAILED"],
  },
  {
    processKey: "approvals",
    label: "Approvals",
    stages: ["REQUESTED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"],
  },
] as const;

type TransitionRow = {
  id: string;
  processKey: string;
  fromStage: string;
  toStage: string;
  transitionCount: number;
  totalDurationMs: bigint | number;
  metadata?: unknown;
};

type ProcessTwinDb = {
  processDefinition: {
    upsert(args: unknown): Promise<unknown>;
  };
  processTransitionStat: {
    upsert(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<TransitionRow[]>;
    update(args: unknown): Promise<unknown>;
  };
  automationOpportunity: {
    findFirst(args: unknown): Promise<unknown | null>;
    create(args: unknown): Promise<unknown>;
  };
};

const db = prisma as unknown as ProcessTwinDb;
const DAY_MS = 86_400_000;

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export async function ensureProcessDefinitions() {
  return Promise.all(
    BUILTIN_PROCESSES.map((definition) =>
      db.processDefinition.upsert({
        where: { processKey: definition.processKey },
        create: {
          ...definition,
          description: `Built-in Agent Desk ${definition.label.toLowerCase()} process`,
          active: true,
        },
        update: {
          label: definition.label,
          stages: [...definition.stages],
          active: true,
        },
      }),
    ),
  );
}

export async function applyProcessEvent(input: {
  organisationId: string;
  processKey: string;
  fromStage: string;
  toStage: string;
  durationMs?: number;
  humanIntervention?: boolean;
  windowStart?: Date;
}) {
  const windowStart = utcDay(input.windowStart ?? new Date());
  const windowEnd = new Date(windowStart.getTime() + DAY_MS);
  const durationMs = Math.max(0, Math.trunc(input.durationMs ?? 0));
  const isLoop = input.fromStage === input.toStage;
  const where = {
    organisationId_processKey_fromStage_toStage_windowStart: {
      organisationId: input.organisationId,
      processKey: input.processKey,
      fromStage: input.fromStage,
      toStage: input.toStage,
      windowStart,
    },
  };
  return db.processTransitionStat.upsert({
    where,
    create: {
      organisationId: input.organisationId,
      processKey: input.processKey,
      fromStage: input.fromStage,
      toStage: input.toStage,
      windowStart,
      windowEnd,
      transitionCount: 1,
      totalDurationMs: BigInt(durationMs),
      loopCount: isLoop ? 1 : 0,
      humanInterventionCount: input.humanIntervention ? 1 : 0,
      metadata: { durationAggregation: "counter_only" },
    },
    update: {
      transitionCount: { increment: 1 },
      totalDurationMs: { increment: BigInt(durationMs) },
      loopCount: { increment: isLoop ? 1 : 0 },
      humanInterventionCount: {
        increment: input.humanIntervention ? 1 : 0,
      },
    },
  });
}

function durationSamples(metadata: unknown): number[] | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const samples = (metadata as { durationSamples?: unknown }).durationSamples;
  if (!Array.isArray(samples)) return null;
  const valid = samples.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return valid.length > 0 ? valid.sort((a, b) => a - b) : null;
}

function percentile(samples: number[], fraction: number): number {
  const index = Math.ceil(fraction * samples.length) - 1;
  return Math.round(samples[Math.max(0, index)]!);
}

/**
 * Repairs derived rates from durable counters. Counter-only rows retain null
 * percentiles: an average is not an honest p50/p90 substitute.
 */
export async function reconcileProcessWindow(
  organisationId: string,
  processKey: string,
  since: Date,
) {
  const rows = await db.processTransitionStat.findMany({
    where: { organisationId, processKey, windowStart: { gte: since } },
  });
  const outgoingByStage = new Map<string, number>();
  for (const row of rows) {
    outgoingByStage.set(
      row.fromStage,
      (outgoingByStage.get(row.fromStage) ?? 0) + row.transitionCount,
    );
  }

  await Promise.all(
    rows.map((row) => {
      const outgoing = outgoingByStage.get(row.fromStage) ?? 0;
      const conversionRate = outgoing > 0 ? row.transitionCount / outgoing : null;
      const averageDurationMs =
        row.transitionCount > 0
          ? Number(BigInt(row.totalDurationMs) / BigInt(row.transitionCount))
          : null;
      const samples = durationSamples(row.metadata);
      return db.processTransitionStat.update({
        where: { id: row.id },
        data: {
          conversionRate,
          dropOffRate: conversionRate == null ? null : 1 - conversionRate,
          p50DurationMs: samples ? percentile(samples, 0.5) : null,
          p90DurationMs: samples ? percentile(samples, 0.9) : null,
          metadata: {
            ...(row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
              ? row.metadata
              : {}),
            averageDurationMs,
            percentileMethod: samples ? "duration_samples" : "unavailable_without_histogram",
          },
        },
      });
    }),
  );
  return { reconciled: rows.length };
}

export async function detectAutomationOpportunities(input: {
  organisationId: string;
  processKey: string;
  since: Date;
  volumeThreshold?: number;
  highDelayMs?: number;
}) {
  const volumeThreshold = Math.max(1, Math.trunc(input.volumeThreshold ?? 20));
  const highDelayMs = Math.max(1, Math.trunc(input.highDelayMs ?? 60_000));
  const rows = await db.processTransitionStat.findMany({
    where: {
      organisationId: input.organisationId,
      processKey: input.processKey,
      windowStart: { gte: input.since },
      transitionCount: { gte: volumeThreshold },
    },
  });
  const created: unknown[] = [];
  for (const row of rows) {
    const delayMs =
      row.transitionCount > 0
        ? Number(BigInt(row.totalDurationMs) / BigInt(row.transitionCount))
        : 0;
    if (delayMs < highDelayMs) continue;
    const existing = await db.automationOpportunity.findFirst({
      where: {
        organisationId: input.organisationId,
        processKey: input.processKey,
        fromStage: row.fromStage,
        toStage: row.toStage,
        status: { in: ["DETECTED", "REVIEWING", "APPROVED"] },
      },
    });
    if (existing) continue;
    created.push(
      await db.automationOpportunity.create({
        data: {
          organisationId: input.organisationId,
          processKey: input.processKey,
          fromStage: row.fromStage,
          toStage: row.toStage,
          title: `Review automation for ${row.fromStage} → ${row.toStage}`,
          volume: row.transitionCount,
          delayMs,
          status: "DETECTED",
          confidenceBand: row.transitionCount >= volumeThreshold * 2 ? "MEDIUM" : "LOW",
          metadata: {
            source: "process_twin_counters",
            recommendationOnly: true,
            automationRuleEnabled: false,
          },
        },
      }),
    );
  }
  return created;
}
