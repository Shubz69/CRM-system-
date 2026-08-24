/**
 * Atomic DomainEvent append — MUST use the caller's Prisma transaction client.
 * Never starts a nested transaction.
 */

import {
  DomainEventStatus,
  type DomainEvent,
  type Prisma,
} from "@prisma/client";
import {
  CURRENT_EVENT_VERSION,
  isDomainEventType,
  parseDomainEventPayload,
  type DomainEventType,
} from "@/services/domain-events/catalogue";

export type AppendDomainEventInput = {
  organisationId: string;
  eventType: DomainEventType | string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion?: number;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  availableAt?: Date;
  correlationId?: string | null;
  causationId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
};

export class DomainEventValidationError extends Error {
  readonly code = "DOMAIN_EVENT_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "DomainEventValidationError";
  }
}

/**
 * Insert a DomainEvent inside an existing transaction.
 * Business payload is validated and treated as immutable thereafter.
 */
export async function appendDomainEvent(
  tx: Prisma.TransactionClient,
  input: AppendDomainEventInput,
): Promise<DomainEvent> {
  if (!isDomainEventType(input.eventType)) {
    throw new DomainEventValidationError(`Unknown event type: ${input.eventType}`);
  }
  const version = input.eventVersion ?? CURRENT_EVENT_VERSION;
  const payload = parseDomainEventPayload(input.eventType, version, {
    organisationId: input.organisationId,
    ...input.payload,
  });

  if (payload.organisationId !== input.organisationId) {
    throw new DomainEventValidationError("payload.organisationId must match event organisationId");
  }

  if (input.dedupeKey) {
    const existing = await tx.domainEvent.findFirst({
      where: { organisationId: input.organisationId, dedupeKey: input.dedupeKey },
    });
    if (existing) return existing;
  }

  const last = await tx.domainEvent.findFirst({
    where: {
      organisationId: input.organisationId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
    },
    orderBy: { aggregateSequence: "desc" },
    select: { aggregateSequence: true },
  });
  const aggregateSequence = (last?.aggregateSequence ?? 0) + 1;

  return tx.domainEvent.create({
    data: {
      organisationId: input.organisationId,
      eventType: input.eventType,
      eventVersion: version,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: payload as unknown as Prisma.InputJsonValue,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      occurredAt: input.occurredAt ?? new Date(),
      availableAt: input.availableAt ?? new Date(),
      status: DomainEventStatus.PENDING,
      correlationId: input.correlationId ?? undefined,
      causationId: input.causationId ?? undefined,
      actorType: input.actorType ?? undefined,
      actorId: input.actorId ?? undefined,
      dedupeKey: input.dedupeKey ?? undefined,
      maxAttempts: input.maxAttempts ?? 8,
      aggregateSequence,
    },
  });
}

/**
 * Compatibility wrapper for Phase 12 Mission hook.
 * Maps free-form eventType strings onto catalogue types when possible.
 */
export async function prepareDomainEventAttach(
  tx: Prisma.TransactionClient,
  event: {
    organisationId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
    correlationId?: string | null;
    causationId?: string | null;
  },
): Promise<DomainEvent | null> {
  const mapped = mapLegacyMissionEventType(event.eventType);
  if (!mapped) return null;
  return appendDomainEvent(tx, {
    organisationId: event.organisationId,
    eventType: mapped,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: { ...event.payload, missionId: event.aggregateId },
    correlationId: event.correlationId,
    causationId: event.causationId,
  });
}

function mapLegacyMissionEventType(raw: string): DomainEventType | null {
  const table: Record<string, DomainEventType> = {
    "mission.created": "MISSION_CREATED",
    "mission.status.RUNNING": "MISSION_STARTED",
    "mission.status.WAITING_APPROVAL": "MISSION_WAITING_APPROVAL",
    "mission.status.COMPLETED": "MISSION_COMPLETED",
    "mission.status.FAILED": "MISSION_FAILED",
    "mission.status.CANCELLED": "MISSION_CANCELLED",
  };
  return table[raw] ?? (isDomainEventType(raw) ? raw : null);
}
