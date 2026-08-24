/**
 * Postgres outbox dispatcher — claim with FOR UPDATE SKIP LOCKED, then process.
 * Does not hold DB locks across consumer I/O.
 */

import { randomUUID } from "crypto";
import {
  DomainEventStatus,
  Prisma,
  type DomainEvent,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  DOMAIN_EVENT_CONSUMERS,
  runConsumerIdempotent,
} from "@/services/domain-events/consumers";
import {
  assertDomainEventTransition,
  classifyOutboxError,
  nextRetryDelayMs,
} from "@/services/domain-events/state";
import { UnsupportedEventVersionError } from "@/services/domain-events/catalogue";

const STALE_LOCK_MS = Number(process.env.OUTBOX_STALE_LOCK_MS || 5 * 60_000);
const DEFAULT_BATCH = Number(process.env.OUTBOX_BATCH_SIZE || 20);

type ClaimedRow = {
  id: string;
  organisationId: string;
  eventType: string;
  eventVersion: number;
  status: DomainEventStatus;
  attemptCount: number;
  maxAttempts: number;
};

/**
 * Atomically claim a batch of ready events for this lock owner.
 */
export async function claimDomainEventBatch(input?: {
  batchSize?: number;
  lockOwner?: string;
  organisationId?: string;
}): Promise<DomainEvent[]> {
  const batchSize = input?.batchSize ?? DEFAULT_BATCH;
  const lockOwner = input?.lockOwner ?? `worker-${randomUUID()}`;
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);

  // Raw SQL for SKIP LOCKED — Prisma does not expose it directly.
  const orgFilter = input?.organisationId
    ? Prisma.sql`AND "organisationId" = ${input.organisationId}`
    : Prisma.empty;

  const claimed = await prisma.$queryRaw<ClaimedRow[]>`
    WITH ready AS (
      SELECT id
      FROM "DomainEvent"
      WHERE status IN ('PENDING'::"DomainEventStatus", 'RETRY'::"DomainEventStatus")
        AND "availableAt" <= NOW()
        AND (
          "lockedAt" IS NULL
          OR "lockedAt" < ${staleBefore}
          OR status = 'RETRY'::"DomainEventStatus"
        )
        ${orgFilter}
      ORDER BY "availableAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "DomainEvent" e
    SET
      status = 'PROCESSING'::"DomainEventStatus",
      "lockedAt" = NOW(),
      "lockOwner" = ${lockOwner},
      "attemptCount" = e."attemptCount" + 1
    FROM ready
    WHERE e.id = ready.id
    RETURNING e.id, e."organisationId", e."eventType", e."eventVersion", e.status, e."attemptCount", e."maxAttempts"
  `;

  if (!claimed.length) return [];

  return prisma.domainEvent.findMany({
    where: { id: { in: claimed.map((c) => c.id) } },
  });
}

async function markProcessed(event: DomainEvent): Promise<void> {
  assertDomainEventTransition(event.status, DomainEventStatus.PROCESSED);
  await prisma.domainEvent.update({
    where: { id: event.id },
    data: {
      status: DomainEventStatus.PROCESSED,
      processedAt: new Date(),
      lockedAt: null,
      lockOwner: null,
      lastError: null,
      errorClass: null,
    },
  });
}

async function markRetryOrDead(
  event: DomainEvent,
  error: unknown,
): Promise<void> {
  const errorClass = classifyOutboxError(error);
  const message = error instanceof Error ? error.message : String(error);
  const attempts = event.attemptCount;
  const exhausted = attempts >= event.maxAttempts || errorClass === "PERMANENT";

  if (exhausted) {
    assertDomainEventTransition(event.status, DomainEventStatus.DEAD_LETTER);
    await prisma.domainEvent.update({
      where: { id: event.id },
      data: {
        status: DomainEventStatus.DEAD_LETTER,
        lockedAt: null,
        lockOwner: null,
        lastError: message.slice(0, 2000),
        errorClass,
        firstFailedAt: event.firstFailedAt ?? new Date(),
        lastFailedAt: new Date(),
      },
    });
    return;
  }

  assertDomainEventTransition(event.status, DomainEventStatus.RETRY);
  await prisma.domainEvent.update({
    where: { id: event.id },
    data: {
      status: DomainEventStatus.RETRY,
      availableAt: new Date(Date.now() + nextRetryDelayMs(attempts)),
      lockedAt: null,
      lockOwner: null,
      lastError: message.slice(0, 2000),
      errorClass,
      firstFailedAt: event.firstFailedAt ?? new Date(),
      lastFailedAt: new Date(),
    },
  });
}

/**
 * Process a claimed event through all consumers (fan-out with per-consumer idempotency).
 */
export async function processClaimedDomainEvent(event: DomainEvent): Promise<void> {
  // Refresh status — claim already set PROCESSING
  const current = await prisma.domainEvent.findFirst({
    where: { id: event.id, organisationId: event.organisationId },
  });
  if (!current || current.status === DomainEventStatus.CANCELLED) return;
  if (current.status !== DomainEventStatus.PROCESSING) return;

  try {
    // Version gate early
    if (current.eventVersion !== 1) {
      throw new UnsupportedEventVersionError(current.eventType, current.eventVersion);
    }

    let anyTransientFailure: unknown = null;
    for (const consumer of DOMAIN_EVENT_CONSUMERS) {
      try {
        await runConsumerIdempotent(current, consumer);
      } catch (error) {
        const klass = classifyOutboxError(error);
        if (klass === "PERMANENT") throw error;
        anyTransientFailure = error;
        logger.warn("Outbox consumer transient failure", {
          eventId: current.id,
          consumer: consumer.name,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    if (anyTransientFailure) {
      await markRetryOrDead({ ...current, status: DomainEventStatus.PROCESSING }, anyTransientFailure);
      return;
    }

    await markProcessed({ ...current, status: DomainEventStatus.PROCESSING });
  } catch (error) {
    await markRetryOrDead({ ...current, status: DomainEventStatus.PROCESSING }, error);
  }
}

/** Sweep: claim + process a batch. Safe for multiple worker instances. */
export async function dispatchDomainEventBatch(input?: {
  batchSize?: number;
  organisationId?: string;
}): Promise<{ claimed: number; processed: number }> {
  const claimed = await claimDomainEventBatch(input);
  let processed = 0;
  for (const event of claimed) {
    await processClaimedDomainEvent(event);
    processed += 1;
  }
  if (claimed.length) {
    logger.info("Outbox dispatch batch complete", {
      claimed: claimed.length,
      processed,
    });
  }
  return { claimed: claimed.length, processed };
}

/** Stale PROCESSING locks older than STALE_LOCK_MS → RETRY. */
export async function recoverStaleDomainEventClaims(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  const result = await prisma.domainEvent.updateMany({
    where: {
      status: DomainEventStatus.PROCESSING,
      lockedAt: { lt: staleBefore },
    },
    data: {
      status: DomainEventStatus.RETRY,
      availableAt: new Date(),
      lockedAt: null,
      lockOwner: null,
      lastError: "Stale claim recovered after lock timeout",
      errorClass: "TRANSIENT",
      lastFailedAt: new Date(),
    },
  });
  return result.count;
}
