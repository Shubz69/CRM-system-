import { OrganisationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertOrganisationMutable } from "@/lib/platform-org";
import { writeAuditLog } from "@/services/audit";
import { logger } from "@/lib/logger";

/**
 * Organisation deletion policy (Prompt 1.5 follow-up):
 *
 * 1. Normal path = soft-delete (`deletedAt`) + suspend. Operational CRM data
 *    stays for retention; ledgers stay attached.
 * 2. Ledger FKs (AuditLog, UsageRecord, AiExecution, WebhookEvent, FailedJob)
 *    use ON DELETE RESTRICT so accidental `organisation.delete()` cannot wipe
 *    compliance or billing history.
 * 3. Hard purge is an explicit admin operation: export ledger snapshot →
 *    delete ledger rows deliberately → then hard-delete the org (CASCADE still
 *    clears conversations/messages/leads).
 *
 * Rejected alternatives:
 * - Reassign ledgers to the platform org: mixes tenant billing into platform
 *   spend and falsifies AuditLog ORG attribution (PLATFORM rows use null org).
 * - CASCADE on ledgers: silent destruction of the trail — unacceptable.
 */

export type OrganisationLedgerExport = {
  organisationId: string;
  exportedAt: string;
  counts: {
    auditLogs: number;
    usageRecords: number;
    aiExecutions: number;
    webhookEvents: number;
    failedJobs: number;
  };
};

/** Soft-delete: hide workspace from normal UI; keep all rows including ledgers. */
export async function softDeleteOrganisation(input: {
  organisationId: string;
  actorUserId?: string | null;
  reason?: string;
}): Promise<{ id: string; deletedAt: Date }> {
  await assertOrganisationMutable(input.organisationId);

  const updated = await prisma.organisation.update({
    where: { id: input.organisationId },
    data: {
      deletedAt: new Date(),
      status: OrganisationStatus.SUSPENDED,
      autopilotMode: "PAUSED",
    },
    select: { id: true, deletedAt: true },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId ?? null,
    action: "workspace.soft_delete",
    entityType: "Organisation",
    entityId: input.organisationId,
    metadata: { reason: input.reason ?? null },
  });

  if (!updated.deletedAt) {
    throw new Error("Soft-delete failed to set deletedAt");
  }

  return { id: updated.id, deletedAt: updated.deletedAt };
}

/** Count ledger rows that block hard-delete under RESTRICT. */
export async function exportOrganisationLedgers(
  organisationId: string,
): Promise<OrganisationLedgerExport> {
  const [auditLogs, usageRecords, aiExecutions, webhookEvents, failedJobs] =
    await Promise.all([
      prisma.auditLog.count({ where: { organisationId } }),
      prisma.usageRecord.count({ where: { organisationId } }),
      prisma.aiExecution.count({ where: { organisationId } }),
      prisma.webhookEvent.count({ where: { organisationId } }),
      prisma.failedJob.count({ where: { organisationId } }),
    ]);

  return {
    organisationId,
    exportedAt: new Date().toISOString(),
    counts: { auditLogs, usageRecords, aiExecutions, webhookEvents, failedJobs },
  };
}

/**
 * Hard purge — deliberate only. Requires `confirmSlug` to match the org slug.
 * Exports counts (caller should persist/export before calling), deletes ledger
 * rows explicitly, then hard-deletes the organisation so CASCADE clears CRM
 * operational children.
 */
export async function purgeOrganisationHard(input: {
  organisationId: string;
  confirmSlug: string;
  actorUserId?: string | null;
}): Promise<{ export: OrganisationLedgerExport }> {
  await assertOrganisationMutable(input.organisationId);

  const org = await prisma.organisation.findUnique({
    where: { id: input.organisationId },
    select: { id: true, slug: true, name: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.slug !== input.confirmSlug) {
    throw new Error("confirmSlug does not match organisation slug — aborting purge");
  }

  const ledgerExport = await exportOrganisationLedgers(org.id);

  // Platform-scoped audit of the purge intent (survives tenant wipe).
  await writeAuditLog({
    scope: "PLATFORM",
    organisationId: null,
    userId: input.actorUserId ?? null,
    action: "workspace.purge_started",
    entityType: "Organisation",
    entityId: org.id,
    metadata: {
      slug: org.slug,
      name: org.name,
      ledgerExport,
    },
  });

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { organisationId: org.id } });
    await tx.usageRecord.deleteMany({ where: { organisationId: org.id } });
    await tx.aiExecution.deleteMany({ where: { organisationId: org.id } });
    await tx.webhookEvent.deleteMany({ where: { organisationId: org.id } });
    await tx.failedJob.deleteMany({ where: { organisationId: org.id } });
    await tx.organisation.delete({ where: { id: org.id } });
  });

  logger.warn("Organisation hard-purged after explicit ledger wipe", {
    organisationId: org.id,
    slug: org.slug,
    ledgerExport,
  });

  return { export: ledgerExport };
}
