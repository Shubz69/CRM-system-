/**
 * Domain event admin / ops helpers — Postgres-backed, no Redis hammering.
 */

import { DomainEventStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import { assertDomainEventTransition } from "@/services/domain-events/state";

export async function getOutboxOpsSnapshot(organisationId?: string) {
  const where = organisationId ? { organisationId } : {};
  const [
    pending,
    processing,
    retry,
    deadLetter,
    processed,
    oldestPending,
    recentDead,
  ] = await Promise.all([
    prisma.domainEvent.count({ where: { ...where, status: DomainEventStatus.PENDING } }),
    prisma.domainEvent.count({ where: { ...where, status: DomainEventStatus.PROCESSING } }),
    prisma.domainEvent.count({ where: { ...where, status: DomainEventStatus.RETRY } }),
    prisma.domainEvent.count({ where: { ...where, status: DomainEventStatus.DEAD_LETTER } }),
    prisma.domainEvent.count({ where: { ...where, status: DomainEventStatus.PROCESSED } }),
    prisma.domainEvent.findFirst({
      where: {
        ...where,
        status: { in: [DomainEventStatus.PENDING, DomainEventStatus.RETRY] },
      },
      orderBy: { availableAt: "asc" },
      select: { id: true, availableAt: true, eventType: true, organisationId: true },
    }),
    prisma.domainEvent.findMany({
      where: { ...where, status: DomainEventStatus.DEAD_LETTER },
      orderBy: { lastFailedAt: "desc" },
      take: 20,
      select: {
        id: true,
        organisationId: true,
        eventType: true,
        attemptCount: true,
        lastError: true,
        errorClass: true,
        correlationId: true,
        lastFailedAt: true,
        firstFailedAt: true,
      },
    }),
  ]);

  return {
    pending,
    processing,
    retry,
    deadLetter,
    processed,
    oldestPending,
    recentDead,
    note: "Postgres-backed outbox metrics. Refresh on demand — not Upstash billing.",
  };
}

export async function retryDeadLetterEvent(input: {
  organisationId: string;
  eventId: string;
  actorUserId?: string;
}): Promise<{ ok: true }> {
  const event = await prisma.domainEvent.findFirst({
    where: { id: input.eventId, organisationId: input.organisationId },
  });
  if (!event) throw new Error("Event not found for organisation");
  assertDomainEventTransition(event.status, DomainEventStatus.RETRY);
  await prisma.domainEvent.update({
    where: { id: event.id },
    data: {
      status: DomainEventStatus.RETRY,
      availableAt: new Date(),
      lockedAt: null,
      lockOwner: null,
      lastError: null,
    },
  });
  await writeAuditLog({
    organisationId: input.organisationId,
    action: "domain_event.dead_letter_retry",
    entityType: "DomainEvent",
    entityId: event.id,
    userId: input.actorUserId,
    metadata: { eventType: event.eventType },
  });
  return { ok: true };
}

export async function cancelDomainEvent(input: {
  organisationId: string;
  eventId: string;
  actorUserId?: string;
}): Promise<{ ok: true }> {
  const event = await prisma.domainEvent.findFirst({
    where: { id: input.eventId, organisationId: input.organisationId },
  });
  if (!event) throw new Error("Event not found for organisation");
  assertDomainEventTransition(event.status, DomainEventStatus.CANCELLED);
  await prisma.domainEvent.update({
    where: { id: event.id },
    data: {
      status: DomainEventStatus.CANCELLED,
      lockedAt: null,
      lockOwner: null,
    },
  });
  await writeAuditLog({
    organisationId: input.organisationId,
    action: "domain_event.cancelled",
    entityType: "DomainEvent",
    entityId: event.id,
    userId: input.actorUserId,
    metadata: { eventType: event.eventType, fromStatus: event.status },
  });
  return { ok: true };
}

export async function getDomainEventForOrg(
  organisationId: string,
  eventId: string,
) {
  return prisma.domainEvent.findFirst({
    where: { id: eventId, organisationId },
    include: { consumptions: true },
  });
}

export type { Prisma };
