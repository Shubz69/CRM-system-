/**
 * External object mapping + sync cursor/run engine.
 */

import { SyncRunKind, SyncRunStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";

export async function upsertExternalObjectMapping(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  externalType: string;
  externalId: string;
  internalType: string;
  internalId: string;
  externalUrl?: string;
  externalUpdatedAt?: Date;
  syncVersion?: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.externalObjectMapping.upsert({
    where: {
      organisationId_providerKey_externalType_externalId: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        externalType: input.externalType,
        externalId: input.externalId,
      },
    },
    create: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef: input.connectionRef ?? undefined,
      externalType: input.externalType,
      externalId: input.externalId,
      internalType: input.internalType,
      internalId: input.internalId,
      externalUrl: input.externalUrl,
      externalUpdatedAt: input.externalUpdatedAt,
      syncVersion: input.syncVersion,
      lastSyncedAt: new Date(),
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      internalType: input.internalType,
      internalId: input.internalId,
      externalUrl: input.externalUrl,
      lastSeenAt: new Date(),
      lastSyncedAt: new Date(),
      externalUpdatedAt: input.externalUpdatedAt,
      syncVersion: input.syncVersion,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function getSyncCursor(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  resource: string;
}) {
  return prisma.syncCursor.findUnique({
    where: {
      organisationId_providerKey_connectionRef_resource: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef: input.connectionRef ?? "env",
        resource: input.resource,
      },
    },
  });
}

export async function saveSyncCursor(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  resource: string;
  cursorValue: string;
  cursorKind?: string;
}) {
  const connectionRef = input.connectionRef ?? "env";
  return prisma.syncCursor.upsert({
    where: {
      organisationId_providerKey_connectionRef_resource: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        resource: input.resource,
      },
    },
    create: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef,
      resource: input.resource,
      cursorValue: input.cursorValue,
      cursorKind: input.cursorKind ?? "opaque",
    },
    update: {
      cursorValue: input.cursorValue,
      cursorKind: input.cursorKind ?? "opaque",
    },
  });
}

/**
 * Generic sync runner skeleton — adapters supply fetchBatch.
 * Persists cursor before returning so crashes resume safely.
 */
export async function runConnectorSync(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  resource: string;
  kind?: SyncRunKind;
  batchSize?: number;
  fetchBatch: (cursor: string | null, limit: number) => Promise<{
    items: Array<{
      externalId: string;
      externalType: string;
      internalType: string;
      internalId: string;
      externalUrl?: string;
      externalUpdatedAt?: Date;
    }>;
    nextCursor: string | null;
    complete: boolean;
  }>;
}) {
  const connectionRef = input.connectionRef ?? "env";
  const existing = await getSyncCursor({
    organisationId: input.organisationId,
    providerKey: input.providerKey,
    connectionRef,
    resource: input.resource,
  });

  const run = await prisma.syncRun.create({
    data: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef,
      resource: input.resource,
      kind: input.kind ?? (existing ? SyncRunKind.INCREMENTAL : SyncRunKind.FULL_INITIAL),
      status: SyncRunStatus.RUNNING,
      cursorBefore: existing?.cursorValue,
    },
  });

  let created = 0;
  let updated = 0;
  let failed = 0;
  let processed = 0;
  let cursor = existing?.cursorValue ?? null;

  try {
    const batch = await input.fetchBatch(cursor, input.batchSize ?? 50);
    for (const item of batch.items) {
      try {
        const before = await prisma.externalObjectMapping.findUnique({
          where: {
            organisationId_providerKey_externalType_externalId: {
              organisationId: input.organisationId,
              providerKey: input.providerKey,
              externalType: item.externalType,
              externalId: item.externalId,
            },
          },
        });
        await upsertExternalObjectMapping({
          organisationId: input.organisationId,
          providerKey: input.providerKey,
          connectionRef,
          ...item,
        });
        if (before) updated += 1;
        else created += 1;
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    if (batch.nextCursor) {
      await saveSyncCursor({
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        resource: input.resource,
        cursorValue: batch.nextCursor,
      });
      cursor = batch.nextCursor;
    }

    const status =
      failed > 0 && processed > 0
        ? SyncRunStatus.PARTIAL
        : failed > 0
          ? SyncRunStatus.FAILED
          : SyncRunStatus.SUCCEEDED;

    const finished = await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        processedCount: processed,
        createdCount: created,
        updatedCount: updated,
        failedCount: failed,
        cursorAfter: cursor,
      },
    });

    if (status === SyncRunStatus.SUCCEEDED || status === SyncRunStatus.PARTIAL) {
      await prisma.$transaction(async (tx) => {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "SYNC_COMPLETED",
          aggregateType: "SyncRun",
          aggregateId: run.id,
          payload: {
            syncRunId: run.id,
            providerKey: input.providerKey,
            resource: input.resource,
            status,
          },
        });
      });
    } else {
      await prisma.$transaction(async (tx) => {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "SYNC_FAILED",
          aggregateType: "SyncRun",
          aggregateId: run.id,
          payload: {
            syncRunId: run.id,
            providerKey: input.providerKey,
            resource: input.resource,
            errorSummary: "batch failures",
          },
        });
      });
    }

    return finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync failed";
    const finished = await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: SyncRunStatus.FAILED,
        finishedAt: new Date(),
        errorSummary: message,
        failedCount: failed + 1,
        processedCount: processed,
      },
    });
    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "SYNC_FAILED",
        aggregateType: "SyncRun",
        aggregateId: run.id,
        payload: {
          syncRunId: run.id,
          providerKey: input.providerKey,
          resource: input.resource,
          errorSummary: message.slice(0, 500),
        },
      });
    });
    return finished;
  }
}
