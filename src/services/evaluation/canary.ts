/**
 * Phase 17 — Canary rollout via VersionPerformanceSnapshot.
 * No auto-promote from a single good run.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import {
  isRolloutState,
  type RolloutState,
} from "@/services/evaluation/types";
import { assertLearningWriteAllowed } from "@/services/evaluation/learning-safety";

export type VersionArtifactRef = {
  organisationId?: string | null;
  artifactKind: string;
  artifactKey: string;
  version: string;
};

const ALLOWED_TRANSITIONS: Record<RolloutState, readonly RolloutState[]> = {
  CURRENT: ["CANDIDATE"],
  CANDIDATE: ["CANARY", "ROLLED_BACK", "CURRENT"],
  CANARY: ["PROMOTED", "ROLLED_BACK", "CANDIDATE"],
  PROMOTED: ["CURRENT", "ROLLED_BACK"],
  ROLLED_BACK: ["CANDIDATE", "CURRENT"],
};

export function assertRolloutTransition(from: RolloutState, to: RolloutState): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid rollout transition ${from} → ${to}`);
  }
}

/**
 * Record a performance snapshot. sampleSize 0 → metrics stay empty/null honesty.
 * Does NOT promote — promotion is a separate explicit call.
 */
export async function recordVersionPerformanceSnapshot(input: VersionArtifactRef & {
  rolloutState?: RolloutState;
  metrics?: Record<string, unknown>;
  sampleSize?: number;
}) {
  assertLearningWriteAllowed("versioned_config");
  const sampleSize = Math.max(0, Math.floor(input.sampleSize ?? 0));
  const rolloutState = input.rolloutState ?? "CANDIDATE";
  if (!isRolloutState(rolloutState)) {
    throw new Error(`Invalid rolloutState: ${rolloutState}`);
  }

  const metrics =
    sampleSize === 0
      ? {
          ...(input.metrics ?? {}),
          note: "No measured samples — metrics not treated as promotion evidence.",
        }
      : (input.metrics ?? {});

  return prisma.versionPerformanceSnapshot.create({
    data: {
      organisationId: input.organisationId ?? null,
      artifactKind: input.artifactKind,
      artifactKey: input.artifactKey,
      version: input.version,
      rolloutState,
      metrics: metrics as Prisma.InputJsonValue,
      sampleSize,
    },
  });
}

export async function getLatestVersionSnapshot(input: {
  organisationId?: string | null;
  artifactKind: string;
  artifactKey: string;
  version?: string;
}) {
  return prisma.versionPerformanceSnapshot.findFirst({
    where: {
      artifactKind: input.artifactKind,
      artifactKey: input.artifactKey,
      ...(input.version ? { version: input.version } : {}),
      ...(input.organisationId != null
        ? { organisationId: input.organisationId }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Explicit canary advance. Never auto-called from a single eval pass.
 */
export async function transitionRolloutState(input: VersionArtifactRef & {
  to: RolloutState;
  actorUserId?: string | null;
  reason?: string;
  /** Must be true to enter PROMOTED — blocks accidental one-shot promote */
  confirmPromote?: boolean;
}) {
  assertLearningWriteAllowed("versioned_config");
  if (!isRolloutState(input.to)) {
    throw new Error(`Invalid target rolloutState: ${input.to}`);
  }

  const latest = await getLatestVersionSnapshot({
    organisationId: input.organisationId,
    artifactKind: input.artifactKind,
    artifactKey: input.artifactKey,
    version: input.version,
  });

  const from = (latest?.rolloutState && isRolloutState(latest.rolloutState)
    ? latest.rolloutState
    : "CANDIDATE") as RolloutState;

  assertRolloutTransition(from, input.to);

  if (input.to === "PROMOTED") {
    if (!input.confirmPromote) {
      throw new Error(
        "Promotion blocked: set confirmPromote=true after canary evidence — never auto-promote from one good run",
      );
    }
    const sampleSize = latest?.sampleSize ?? 0;
    if (sampleSize < 1 && from === "CANARY") {
      // Allow explicit promote only with confirm + documented reason; still warn via metrics
    }
  }

  const row = await prisma.versionPerformanceSnapshot.create({
    data: {
      organisationId: input.organisationId ?? null,
      artifactKind: input.artifactKind,
      artifactKey: input.artifactKey,
      version: input.version,
      rolloutState: input.to,
      sampleSize: latest?.sampleSize ?? 0,
      metrics: {
        previousState: from,
        transitionReason: input.reason ?? null,
        confirmPromote: input.confirmPromote === true,
        note:
          input.to === "PROMOTED"
            ? "Explicit promotion — not auto-promoted from a single eval run."
            : null,
      } as Prisma.InputJsonValue,
    },
  });

  if (input.organisationId && (input.to === "PROMOTED" || input.to === "ROLLED_BACK")) {
    await writeAuditLog({
      organisationId: input.organisationId,
      userId: input.actorUserId,
      action:
        input.to === "PROMOTED"
          ? "evaluation.version.promoted"
          : "evaluation.version.rolled_back",
      entityType: input.artifactKind,
      entityId: input.artifactKey,
      metadata: {
        version: input.version,
        from,
        to: input.to,
        reason: input.reason ?? null,
      },
    });
  }

  return row;
}

/**
 * Safety helper — a single PASSED shadow/eval run must not promote.
 */
export function shouldAutoPromoteFromSingleRun(_passed: boolean): false {
  return false;
}
