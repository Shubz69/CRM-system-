/**
 * Phase 18 — Retention policy descriptions + safe dry-run hooks.
 * No destructive purge without an explicit policy + confirm flag.
 */

import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import {
  DEFAULT_AGENT_RETENTION,
  getOrganisationAgentRetention,
} from "@/services/agent-retention";

export type RetentionPolicyId =
  | "agent_run_detail"
  | "audit_log"
  | "domain_event_processed"
  | "failed_job_resolved"
  | "calibration_samples";

export type RetentionPolicyDescription = {
  id: RetentionPolicyId;
  title: string;
  description: string;
  defaultRetainDays: number | null;
  destructive: boolean;
  maturity: "FOUNDATION" | "WORKING";
};

export const RETENTION_POLICIES: RetentionPolicyDescription[] = [
  {
    id: "agent_run_detail",
    title: "Agent run step / tool detail",
    description:
      "Redacts tool payloads and step detail after configured days (see OrganisationAgentRetention).",
    defaultRetainDays: DEFAULT_AGENT_RETENTION.stepFullDetailDays,
    destructive: true,
    maturity: "WORKING",
  },
  {
    id: "audit_log",
    title: "Organisation audit log",
    description:
      "ORG-scoped AuditLog rows. Purge is FOUNDATION only — no automatic deletion.",
    defaultRetainDays: 365,
    destructive: true,
    maturity: "FOUNDATION",
  },
  {
    id: "domain_event_processed",
    title: "Processed domain events",
    description:
      "PROCESSED outbox rows may be archived later. Dry-run counts only for now.",
    defaultRetainDays: 90,
    destructive: true,
    maturity: "FOUNDATION",
  },
  {
    id: "failed_job_resolved",
    title: "Resolved failed jobs",
    description: "Resolved FailedJob rows eligible for cleanup after retain window.",
    defaultRetainDays: 60,
    destructive: true,
    maturity: "FOUNDATION",
  },
  {
    id: "calibration_samples",
    title: "Confidence calibration samples",
    description: "Keep for hit-rate reporting; purge only under explicit policy.",
    defaultRetainDays: 180,
    destructive: true,
    maturity: "FOUNDATION",
  },
];

export function listRetentionPolicies(): RetentionPolicyDescription[] {
  return RETENTION_POLICIES.map((p) => ({ ...p }));
}

export type RetentionDryRunResult = {
  policyId: RetentionPolicyId;
  organisationId: string;
  eligibleCount: number;
  retainDays: number | null;
  wouldDelete: boolean;
  dryRun: true;
  message: string;
  maturity: RetentionPolicyDescription["maturity"];
};

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Safe dry-run: counts only. Never deletes.
 */
export async function dryRunRetentionPurge(input: {
  organisationId: string;
  policyId: RetentionPolicyId;
}): Promise<RetentionDryRunResult> {
  const policy = RETENTION_POLICIES.find((p) => p.id === input.policyId);
  if (!policy) {
    throw new Error(`Unknown retention policy: ${input.policyId}`);
  }

  let retainDays = policy.defaultRetainDays;
  let eligibleCount = 0;

  switch (input.policyId) {
    case "agent_run_detail": {
      const cfg = await getOrganisationAgentRetention(input.organisationId);
      retainDays = cfg.stepFullDetailDays;
      eligibleCount = await prisma.agentStep.count({
        where: {
          organisationId: input.organisationId,
          createdAt: { lt: daysAgo(cfg.stepFullDetailDays) },
        },
      });
      break;
    }
    case "audit_log": {
      eligibleCount = await prisma.auditLog.count({
        where: {
          organisationId: input.organisationId,
          scope: "ORG",
          createdAt: { lt: daysAgo(retainDays ?? 365) },
        },
      });
      break;
    }
    case "domain_event_processed": {
      eligibleCount = await prisma.domainEvent.count({
        where: {
          organisationId: input.organisationId,
          status: "PROCESSED",
          createdAt: { lt: daysAgo(retainDays ?? 90) },
        },
      });
      break;
    }
    case "failed_job_resolved": {
      eligibleCount = await prisma.failedJob.count({
        where: {
          organisationId: input.organisationId,
          resolvedAt: { lt: daysAgo(retainDays ?? 60) },
        },
      });
      break;
    }
    case "calibration_samples": {
      eligibleCount = await prisma.confidenceCalibrationSample.count({
        where: {
          organisationId: input.organisationId,
          createdAt: { lt: daysAgo(retainDays ?? 180) },
        },
      });
      break;
    }
  }

  return {
    policyId: input.policyId,
    organisationId: input.organisationId,
    eligibleCount,
    retainDays,
    wouldDelete: eligibleCount > 0,
    dryRun: true,
    message: `Dry-run only — ${eligibleCount} row(s) eligible. Destructive purge requires explicit policy confirmation (not implemented for FOUNDATION policies).`,
    maturity: policy.maturity,
  };
}

/**
 * Destructive purge gate — refuses unless confirmDestructive=true AND policy is WORKING.
 * FOUNDATION policies always refuse.
 */
export async function executeRetentionPurge(input: {
  organisationId: string;
  policyId: RetentionPolicyId;
  confirmDestructive?: boolean;
  actorUserId?: string | null;
}): Promise<never> {
  const policy = RETENTION_POLICIES.find((p) => p.id === input.policyId);
  if (!policy) throw new Error(`Unknown retention policy: ${input.policyId}`);

  if (policy.maturity === "FOUNDATION") {
    throw new Error(
      `Retention purge for ${input.policyId} is FOUNDATION — dry-run only; no destructive purge`,
    );
  }

  if (!input.confirmDestructive) {
    throw new Error(
      "Destructive retention purge blocked: set confirmDestructive=true after reviewing dry-run",
    );
  }

  // Agent detail purge already lives in agent-retention workers — do not duplicate here.
  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId,
    action: "enterprise.retention.purge_blocked",
    entityType: "RetentionPolicy",
    entityId: input.policyId,
    metadata: {
      reason: "Use agent-retention worker paths for WORKING agent_run_detail cleanup",
    },
  });

  throw new Error(
    "Purge not executed from enterprise-ops — use dedicated agent-retention workers for agent_run_detail",
  );
}
