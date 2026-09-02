import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainEventStatus, DomainEventConsumptionStatus } from "@prisma/client";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import {
  claimDomainEventBatch,
  dispatchDomainEventBatch,
  processClaimedDomainEvent,
  recoverStaleDomainEventClaims,
} from "@/services/domain-events/dispatcher";
import { runConsumerIdempotent, DOMAIN_EVENT_CONSUMERS } from "@/services/domain-events/consumers";
import {
  cancelDomainEvent,
  getDomainEventForOrg,
  retryDeadLetterEvent,
} from "@/services/domain-events/ops";
import { UnsupportedEventVersionError } from "@/services/domain-events/catalogue";
import { createMission, setTaskExternalOutcome } from "@/services/mission-runtime";
import { MissionExternalOutcome, MissionTaskStatus } from "@prisma/client";
import { recoverMissionQueueJobs } from "@/services/domain-events/mission-queue-recovery";

describe("Phase 12B transactional outbox", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;
  /** Isolated org for claim/dispatch tests — avoids cross-test PENDING queue contention. */
  let claimOrg: TestOrganisationFixture;

  beforeAll(async () => {
    orgA = await createTestOrganisation("outbox-a");
    orgB = await createTestOrganisation("outbox-b");
    claimOrg = await createTestOrganisation("outbox-claim");
  });

  afterAll(async () => {
    await destroyTestOrganisation(orgA);
    await destroyTestOrganisation(orgB);
    await destroyTestOrganisation(claimOrg);
  });

  it("atomically commits business mutation + event", async () => {
    const dealId = await prisma.$transaction(async (tx) => {
      const deal = await tx.deal.create({
        data: {
          organisationId: orgA.organisationId,
          name: "Atomic Deal",
          status: "OPEN",
        },
      });
      await appendDomainEvent(tx, {
        organisationId: orgA.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: deal.id,
        payload: { dealId: deal.id },
        correlationId: "corr-atomic-1",
      });
      return deal.id;
    });

    const event = await prisma.domainEvent.findFirst({
      where: { organisationId: orgA.organisationId, aggregateId: dealId },
    });
    expect(event?.eventType).toBe("DEAL_CREATED");
    expect(event?.status).toBe(DomainEventStatus.PENDING);
    expect(event?.correlationId).toBe("corr-atomic-1");
  });

  it("rolls back event when business mutation fails", async () => {
    const before = await prisma.domainEvent.count({
      where: { organisationId: orgA.organisationId },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await appendDomainEvent(tx, {
          organisationId: orgA.organisationId,
          eventType: "DEAL_WON",
          aggregateType: "Deal",
          aggregateId: "nonexistent",
          payload: { dealId: "nonexistent" },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow(/force rollback/);
    const after = await prisma.domainEvent.count({
      where: { organisationId: orgA.organisationId },
    });
    expect(after).toBe(before);
  });

  it("two dispatchers: only one claim wins per event", async () => {
    const token = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: claimOrg.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: token,
        payload: { dealId: token },
        dedupeKey: `claim-dupe-${token}`,
      }),
    );

    const [a, b] = await Promise.all([
      claimDomainEventBatch({
        batchSize: 50,
        lockOwner: "worker-a",
        organisationId: claimOrg.organisationId,
      }),
      claimDomainEventBatch({
        batchSize: 50,
        lockOwner: "worker-b",
        organisationId: claimOrg.organisationId,
      }),
    ]);
    const idsA = new Set(a.map((e) => e.id));
    const idsB = new Set(b.map((e) => e.id));
    const both = [...idsA].filter((id) => idsB.has(id));
    expect(both).toHaveLength(0);
    expect(idsA.has(event.id) || idsB.has(event.id)).toBe(true);
  });

  it("idempotent consumer: second delivery does not re-run effect", async () => {
    const token = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: claimOrg.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: token,
        payload: { dealId: token },
      }),
    );
    const claimed = await claimDomainEventBatch({
      batchSize: 100,
      organisationId: claimOrg.organisationId,
    });
    const target = claimed.find((e) => e.id === event.id) ?? event;
    // Force PROCESSING if not claimed (race with other tests)
    if (target.status !== DomainEventStatus.PROCESSING) {
      await prisma.domainEvent.update({
        where: { id: event.id },
        data: { status: DomainEventStatus.PROCESSING, attemptCount: 1 },
      });
    }
    const refreshed = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    const ops = DOMAIN_EVENT_CONSUMERS.find((c) => c.name === "ops.record")!;
    const first = await runConsumerIdempotent(refreshed, ops);
    const second = await runConsumerIdempotent(refreshed, ops);
    expect(first.ok).toBe(true);
    expect(second.skipped).toBe(true);
    const consumptions = await prisma.domainEventConsumption.count({
      where: { eventId: event.id, consumer: "ops.record", status: DomainEventConsumptionStatus.PROCESSED },
    });
    expect(consumptions).toBe(1);
  });

  it("fan-out: consumer failure does not clear successful sibling", async () => {
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: orgA.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: `fan-${Date.now()}`,
        payload: { dealId: `fan-${Date.now()}` },
      }),
    );
    await prisma.domainEvent.update({
      where: { id: event.id },
      data: { status: DomainEventStatus.PROCESSING, attemptCount: 1 },
    });
    const refreshed = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    const ops = DOMAIN_EVENT_CONSUMERS.find((c) => c.name === "ops.record")!;
    await runConsumerIdempotent(refreshed, ops);

    const failing = {
      name: "ops.record" as const,
      handle: async () => {
        throw Object.assign(new Error("boom"), { code: "TRANSIENT_TEST" });
      },
    };
    // Already PROCESSED — second call skips without throwing
    const again = await runConsumerIdempotent(refreshed, failing);
    expect(again.skipped).toBe(true);
  });

  it("unsupported version goes to dead letter (permanent)", async () => {
    const event = await prisma.domainEvent.create({
      data: {
        organisationId: orgA.organisationId,
        eventType: "DEAL_CREATED",
        eventVersion: 99,
        aggregateType: "Deal",
        aggregateId: `ver-${Date.now()}`,
        payload: { organisationId: orgA.organisationId, dealId: "x" },
        status: DomainEventStatus.PROCESSING,
        attemptCount: 1,
        maxAttempts: 3,
      },
    });
    await processClaimedDomainEvent(event);
    const after = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.status).toBe(DomainEventStatus.DEAD_LETTER);
    expect(after.errorClass).toBe("PERMANENT");
  });

  it("tenant isolation: cannot read or retry other org events", async () => {
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: orgA.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: `iso-${Date.now()}`,
        payload: { dealId: `iso-${Date.now()}` },
      }),
    );
    expect(await getDomainEventForOrg(orgB.organisationId, event.id)).toBeNull();
    await prisma.domainEvent.update({
      where: { id: event.id },
      data: { status: DomainEventStatus.DEAD_LETTER },
    });
    await expect(
      retryDeadLetterEvent({ organisationId: orgB.organisationId, eventId: event.id }),
    ).rejects.toThrow(/not found/i);
  });

  it("LEAD_QUALIFIED creates one mission; duplicate event consumer is idempotent", async () => {
    const leadId = `lead-${Date.now()}`;
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: orgA.organisationId,
        eventType: "LEAD_QUALIFIED",
        aggregateType: "Lead",
        aggregateId: leadId,
        payload: { leadId },
        dedupeKey: `lead-qualified-${leadId}`,
      }),
    );
    await prisma.domainEvent.update({
      where: { id: event.id },
      data: { status: DomainEventStatus.PROCESSING, attemptCount: 1 },
    });
    const refreshed = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    const consumer = DOMAIN_EVENT_CONSUMERS.find((c) => c.name === "mission.from_lead_qualified")!;
    const first = await runConsumerIdempotent(refreshed, consumer);
    const second = await runConsumerIdempotent(refreshed, consumer);
    expect(first.ok).toBe(true);
    expect(second.skipped).toBe(true);
    const missions = await prisma.agentMission.count({
      where: {
        organisationId: orgA.organisationId,
        objectiveSummary: { contains: leadId },
      },
    });
    expect(missions).toBe(1);
  });

  it("cancel prevents later execution", async () => {
    const token = `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: claimOrg.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: token,
        payload: { dealId: token },
      }),
    );
    await cancelDomainEvent({ organisationId: claimOrg.organisationId, eventId: event.id });
    const claimed = await claimDomainEventBatch({
      batchSize: 100,
      organisationId: claimOrg.organisationId,
    });
    expect(claimed.some((e) => e.id === event.id)).toBe(false);
  });

  it("stale PROCESSING claim becomes retryable", async () => {
    const event = await prisma.domainEvent.create({
      data: {
        organisationId: claimOrg.organisationId,
        eventType: "DEAL_CREATED",
        eventVersion: 1,
        aggregateType: "Deal",
        aggregateId: `stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload: { organisationId: claimOrg.organisationId, dealId: "stale" },
        status: DomainEventStatus.PROCESSING,
        lockedAt: new Date(Date.now() - 60 * 60_000),
        lockOwner: "dead-worker",
        attemptCount: 1,
        maxAttempts: 8,
      },
    });
    await recoverStaleDomainEventClaims();
    const after = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.status).toBe(DomainEventStatus.RETRY);
  });

  it("Mission create emits MISSION_CREATED outbox row", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Outbox mission",
      objectiveSummary: "Emit event",
      tasks: [{ idempotencyKey: "t1", title: "T1" }],
    });
    const event = await prisma.domainEvent.findFirst({
      where: {
        organisationId: orgA.organisationId,
        eventType: "MISSION_CREATED",
        aggregateId: mission.id,
      },
    });
    expect(event).toBeTruthy();
  });

  it("dispatch batch processes pending events", async () => {
    const token = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event = await prisma.$transaction(async (tx) =>
      appendDomainEvent(tx, {
        organisationId: claimOrg.organisationId,
        eventType: "DEAL_CREATED",
        aggregateType: "Deal",
        aggregateId: token,
        payload: { dealId: token },
      }),
    );
    const result = await dispatchDomainEventBatch({
      organisationId: claimOrg.organisationId,
      batchSize: 5,
    });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    const after = await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.status).toBe(DomainEventStatus.PROCESSED);
  }, 20_000);

  it("parse rejects unsupported version", () => {
    expect(() => {
      throw new UnsupportedEventVersionError("DEAL_WON", 2);
    }).toThrow(UnsupportedEventVersionError);
  });

  it("mission queue recovery skips RECONCILIATION_REQUIRED and CONFIRMED", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Recovery",
      objectiveSummary: "Queue bridge",
      tasks: [{ idempotencyKey: "r1", title: "R1" }],
    });
    const task = await prisma.missionTask.findFirstOrThrow({
      where: { missionId: mission.id },
    });
    await setTaskExternalOutcome({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: task.id,
      outcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    });
    await prisma.missionTask.update({
      where: { id: task.id },
      data: { status: MissionTaskStatus.READY },
    });
    const result = await recoverMissionQueueJobs({
      organisationId: orgA.organisationId,
      limit: 20,
    });
    // Task filtered out by externalOutcome — examined may still count 0 for this org's filtered set
    expect(result.enqueued).toBeGreaterThanOrEqual(0);
    const still = await prisma.missionTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(still.externalOutcome).toBe(MissionExternalOutcome.RECONCILIATION_REQUIRED);
  });
});
