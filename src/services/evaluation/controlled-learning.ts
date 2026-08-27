/**
 * Phase 17 — Controlled learning updates.
 * Propose/promote versioned config JSON only — never writes src/ or migrations.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import { assertLearningWriteAllowed } from "@/services/evaluation/learning-safety";
import { LearningSafetyError } from "@/services/evaluation/learning-safety";

export const CONTROLLED_LEARNING_KINDS = [
  "ranking_weights",
  "detector_thresholds",
  "prompt_config",
  "research_strategy",
  "quality_budget_default",
  "model_routing",
] as const;

export type ControlledLearningKind = (typeof CONTROLLED_LEARNING_KINDS)[number];

const MIN_PROPOSE_SAMPLE_SIZE = 10;

export function isControlledLearningKind(
  value: string,
): value is ControlledLearningKind {
  return (CONTROLLED_LEARNING_KINDS as readonly string[]).includes(value);
}

export type ProposeConfigUpdateInput = {
  organisationId: string;
  kind: ControlledLearningKind | string;
  key: string;
  fromVersion: string;
  toVersion: string;
  evidence: Record<string, unknown>;
  sampleSize: number;
  actorUserId?: string | null;
};

/**
 * Record a CANDIDATE VersionPerformanceSnapshot + audit + LEARNING_UPDATE_PROPOSED.
 * Rejects unknown kinds and sampleSize < 10.
 */
export async function proposeConfigUpdate(input: ProposeConfigUpdateInput) {
  assertLearningWriteAllowed("versioned_config");
  if (!isControlledLearningKind(input.kind)) {
    throw new LearningSafetyError(
      `Controlled learning kind not allowed: ${input.kind}. Allowed: ${CONTROLLED_LEARNING_KINDS.join(", ")}`,
    );
  }
  const sampleSize = Math.floor(input.sampleSize);
  if (sampleSize < MIN_PROPOSE_SAMPLE_SIZE) {
    throw new LearningSafetyError(
      `Controlled learning requires sampleSize >= ${MIN_PROPOSE_SAMPLE_SIZE} (got ${sampleSize})`,
    );
  }

  const artifactKind = `controlled_learning:${input.kind}`;
  const artifactKey = input.key;

  return prisma.$transaction(async (tx) => {
    const row = await tx.versionPerformanceSnapshot.create({
      data: {
        organisationId: input.organisationId,
        artifactKind,
        artifactKey,
        version: input.toVersion,
        rolloutState: "CANDIDATE",
        sampleSize,
        metrics: {
          kind: input.kind,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          evidence: input.evidence,
          controlledLearning: true,
          note: "Candidate only — not applied to production source trees.",
        } as Prisma.InputJsonValue,
      },
    });

    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "LEARNING_UPDATE_PROPOSED",
      aggregateType: artifactKind,
      aggregateId: artifactKey,
      payload: {
        artifactKind,
        artifactKey,
        version: input.toVersion,
        sampleSize,
      },
      dedupeKey: `LEARNING_UPDATE_PROPOSED:${artifactKind}:${artifactKey}:${input.toVersion}:${row.id}`,
    });

    await writeAuditLog({
      organisationId: input.organisationId,
      userId: input.actorUserId,
      action: "evaluation.controlled_learning.proposed",
      entityType: artifactKind,
      entityId: artifactKey,
      metadata: {
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        sampleSize,
        kind: input.kind,
        snapshotId: row.id,
      },
    });

    return row;
  });
}

/**
 * Apply promoted config by storing JSON on a PROMOTED VersionPerformanceSnapshot metrics.
 * Never writes src/. Requires an existing PROMOTED snapshot for the artifact.
 */
export async function applyPromotedConfig(input: {
  organisationId: string;
  kind: ControlledLearningKind | string;
  key: string;
  version: string;
  config: Record<string, unknown>;
  actorUserId?: string | null;
}) {
  assertLearningWriteAllowed("versioned_config");
  if (!isControlledLearningKind(input.kind)) {
    throw new LearningSafetyError(
      `Controlled learning kind not allowed: ${input.kind}`,
    );
  }

  const artifactKind = `controlled_learning:${input.kind}`;
  const artifactKey = input.key;

  const promoted = await prisma.versionPerformanceSnapshot.findFirst({
    where: {
      organisationId: input.organisationId,
      artifactKind,
      artifactKey,
      version: input.version,
      rolloutState: "PROMOTED",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!promoted) {
    throw new LearningSafetyError(
      "applyPromotedConfig requires an existing PROMOTED VersionPerformanceSnapshot — refuse to write without promotion",
    );
  }

  const priorMetrics =
    promoted.metrics && typeof promoted.metrics === "object"
      ? (promoted.metrics as Record<string, unknown>)
      : {};

  const row = await prisma.$transaction(async (tx) => {
    const applied = await tx.versionPerformanceSnapshot.create({
      data: {
        organisationId: input.organisationId,
        artifactKind,
        artifactKey,
        version: input.version,
        rolloutState: "PROMOTED",
        sampleSize: promoted.sampleSize,
        metrics: {
          ...priorMetrics,
          appliedConfig: input.config,
          appliedAt: new Date().toISOString(),
          storage: "VersionPerformanceSnapshot.metrics",
          note: "Config stored as JSON snapshot only — never writes src/.",
        } as Prisma.InputJsonValue,
      },
    });

    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "LEARNING_UPDATE_PROMOTED",
      aggregateType: artifactKind,
      aggregateId: artifactKey,
      payload: {
        artifactKind,
        artifactKey,
        version: input.version,
        sampleSize: promoted.sampleSize,
      },
      dedupeKey: `LEARNING_UPDATE_PROMOTED:apply:${artifactKind}:${artifactKey}:${input.version}:${applied.id}`,
    });

    return applied;
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId,
    action: "evaluation.controlled_learning.applied",
    entityType: artifactKind,
    entityId: artifactKey,
    metadata: {
      version: input.version,
      snapshotId: row.id,
      configKeys: Object.keys(input.config),
    },
  });

  return row;
}
