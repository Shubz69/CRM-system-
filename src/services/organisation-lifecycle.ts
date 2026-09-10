import { OrganisationStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertOrganisationMutable } from "@/lib/platform-org";
import { writeAuditLog } from "@/services/audit";
import { logger } from "@/lib/logger";

/** Coerce org ids to plain strings so query builders never accept operator objects. */
function asOrgId(value: unknown): string {
  return z.string().min(1).max(64).parse(value);
}

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
  const organisationId = asOrgId(input.organisationId);
  await assertOrganisationMutable(organisationId);

  const updated = await prisma.organisation.update({
    where: { id: organisationId },
    data: {
      deletedAt: new Date(),
      status: OrganisationStatus.SUSPENDED,
      autopilotMode: "PAUSED",
    },
    select: { id: true, deletedAt: true },
  });

  await writeAuditLog({
    organisationId,
    userId: input.actorUserId ?? null,
    action: "workspace.soft_delete",
    entityType: "Organisation",
    entityId: organisationId,
    metadata: { reason: input.reason ?? null },
  });

  if (!updated.deletedAt) {
    throw new Error("Soft-delete failed to set deletedAt");
  }

  return { id: updated.id, deletedAt: updated.deletedAt };
}

/** Count ledger rows that block hard-delete under RESTRICT. */
export async function exportOrganisationLedgers(
  organisationIdInput: string,
): Promise<OrganisationLedgerExport> {
  const organisationId = asOrgId(organisationIdInput);
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
  const organisationId = asOrgId(input.organisationId);
  const confirmSlug = z.string().min(1).max(120).parse(input.confirmSlug);
  await assertOrganisationMutable(organisationId);

  const org = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: { id: true, slug: true, name: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.slug !== confirmSlug) {
    throw new Error("confirmSlug does not match organisation slug — aborting purge");
  }

  const orgId = asOrgId(org.id);
  const ledgerExport = await exportOrganisationLedgers(orgId);

  // Platform-scoped audit of the purge intent (survives tenant wipe).
  await writeAuditLog({
    scope: "PLATFORM",
    organisationId: null,
    userId: input.actorUserId ?? null,
    action: "workspace.purge_started",
    entityType: "Organisation",
    entityId: orgId,
    metadata: {
      slug: org.slug,
      name: org.name,
      ledgerExport,
    },
  });

  // Plain string equality only — never pass unvalidated request objects into where.
  const purgeOrgId = String(orgId);
  await prisma.$transaction(
    async (tx) => {
      await tx.auditLog.deleteMany({ where: { organisationId: { equals: purgeOrgId } } });
      await tx.usageRecord.deleteMany({ where: { organisationId: { equals: purgeOrgId } } });
      await tx.aiExecution.deleteMany({ where: { organisationId: { equals: purgeOrgId } } });
      await tx.webhookEvent.deleteMany({ where: { organisationId: { equals: purgeOrgId } } });
      await tx.failedJob.deleteMany({ where: { organisationId: { equals: purgeOrgId } } });
      await tx.organisation.delete({ where: { id: { equals: purgeOrgId } } });
    },
    // Supabase pooler + multi-delete purge exceeds Prisma's 5s interactive default.
    { timeout: 30_000, maxWait: 15_000 },
  );

  logger.warn("Organisation hard-purged after explicit ledger wipe", {
    organisationId: orgId,
    slug: org.slug,
    ledgerExport,
  });

  return { export: ledgerExport };
}
