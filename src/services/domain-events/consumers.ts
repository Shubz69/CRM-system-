/**
 * Outbox consumers — each assumes at-least-once delivery.
 * Idempotency via DomainEventConsumption unique (eventId, consumer).
 */

import {
  DomainEventConsumptionStatus,
  type DomainEvent,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  domainEventToAutomationTrigger,
  isDomainEventType,
  parseDomainEventPayload,
} from "@/services/domain-events/catalogue";
import { UnsupportedEventVersionError } from "@/services/domain-events/catalogue";
import { runAutomations } from "@/services/automations";
import { createMission } from "@/services/mission-runtime";

export type DomainEventConsumerName =
  | "automation.trigger"
  | "mission.from_lead_qualified"
  | "ops.record";

export type ConsumerResult = {
  ok: boolean;
  skipped?: boolean;
  resultReference?: string;
  error?: unknown;
};

export type DomainEventConsumer = {
  name: DomainEventConsumerName;
  handle: (event: DomainEvent) => Promise<ConsumerResult>;
};

function asPayload(event: DomainEvent): Record<string, unknown> {
  if (!isDomainEventType(event.eventType)) {
    throw new Error(`Unknown event type ${event.eventType}`);
  }
  return parseDomainEventPayload(
    event.eventType,
    event.eventVersion,
    event.payload,
  );
}

const automationConsumer: DomainEventConsumer = {
  name: "automation.trigger",
  async handle(event) {
    if (!isDomainEventType(event.eventType)) {
      throw new UnsupportedEventVersionError(event.eventType, event.eventVersion);
    }
    const trigger = domainEventToAutomationTrigger(event.eventType);
    if (!trigger) return { ok: true, skipped: true };

    const payload = asPayload(event);
    const executed = await runAutomations({
      organisationId: event.organisationId,
      triggerType: trigger,
      leadId: typeof payload.leadId === "string" ? payload.leadId : undefined,
      contactId: typeof payload.contactId === "string" ? payload.contactId : undefined,
      conversationId:
        typeof payload.conversationId === "string" ? payload.conversationId : undefined,
      payload: {
        domainEventId: event.id,
        eventType: event.eventType,
        correlationId: event.correlationId,
      },
    });
    return { ok: true, resultReference: `automations:${executed}` };
  },
};

/**
 * Optional mission creation from LEAD_QUALIFIED — dedupeKey prevents duplicates.
 */
const missionFromLeadConsumer: DomainEventConsumer = {
  name: "mission.from_lead_qualified",
  async handle(event) {
    if (event.eventType !== "LEAD_QUALIFIED") {
      return { ok: true, skipped: true };
    }
    const payload = asPayload(event);
    const leadId = String(payload.leadId);
    const existingMission = await prisma.agentMission.findFirst({
      where: {
        organisationId: event.organisationId,
        objectiveSummary: { contains: leadId },
        status: { notIn: ["CANCELLED", "FAILED"] },
      },
      select: { id: true },
    });
    if (existingMission) {
      return { ok: true, skipped: true, resultReference: existingMission.id };
    }
    const mission = await createMission({
      organisationId: event.organisationId,
      title: `Follow up qualified lead`,
      objectiveSummary: `Operational follow-up for lead ${leadId}`,
      planSummary: "Qualify→outreach mission from LEAD_QUALIFIED event",
      tasks: [
        {
          idempotencyKey: `lead-${leadId}-research`,
          title: "Review lead context",
        },
        {
          idempotencyKey: `lead-${leadId}-outreach`,
          title: "Prepare outreach",
          dependsOnKeys: [`lead-${leadId}-research`],
        },
      ],
    });
    return { ok: true, resultReference: mission.id };
  },
};

const opsRecordConsumer: DomainEventConsumer = {
  name: "ops.record",
  async handle(event) {
    logger.info("Domain event consumed (ops)", {
      eventId: event.id,
      eventType: event.eventType,
      organisationId: event.organisationId,
      correlationId: event.correlationId,
    });
    return { ok: true, resultReference: event.id };
  },
};

export const DOMAIN_EVENT_CONSUMERS: DomainEventConsumer[] = [
  automationConsumer,
  missionFromLeadConsumer,
  opsRecordConsumer,
];

/**
 * Run one consumer with durable idempotency. Successful prior runs are not replayed.
 */
export async function runConsumerIdempotent(
  event: DomainEvent,
  consumer: DomainEventConsumer,
): Promise<ConsumerResult> {
  const existing = await prisma.domainEventConsumption.findUnique({
    where: {
      eventId_consumer: { eventId: event.id, consumer: consumer.name },
    },
  });
  if (existing?.status === DomainEventConsumptionStatus.PROCESSED) {
    return { ok: true, skipped: true, resultReference: existing.resultReference ?? undefined };
  }
  if (existing?.status === DomainEventConsumptionStatus.SKIPPED) {
    return { ok: true, skipped: true };
  }

  // Tenant guard — never process for mismatched org
  if (existing && existing.organisationId !== event.organisationId) {
    throw new Error("Tenant isolation violation on DomainEventConsumption");
  }

  const row =
    existing ??
    (await prisma.domainEventConsumption.create({
      data: {
        organisationId: event.organisationId,
        eventId: event.id,
        consumer: consumer.name,
        status: DomainEventConsumptionStatus.PROCESSING,
        attemptCount: 1,
      },
    }));

  if (existing) {
    await prisma.domainEventConsumption.update({
      where: { id: row.id },
      data: {
        status: DomainEventConsumptionStatus.PROCESSING,
        attemptCount: { increment: 1 },
      },
    });
  }

  try {
    const result = await consumer.handle(event);
    await prisma.domainEventConsumption.update({
      where: { id: row.id },
      data: {
        status: result.skipped
          ? DomainEventConsumptionStatus.SKIPPED
          : DomainEventConsumptionStatus.PROCESSED,
        processedAt: new Date(),
        resultReference: result.resultReference,
        lastError: null,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "consumer failed";
    await prisma.domainEventConsumption.update({
      where: { id: row.id },
      data: {
        status: DomainEventConsumptionStatus.FAILED,
        lastError: message.slice(0, 2000),
      },
    });
    throw error;
  }
}
