/**
 * Phase 12 — Durable Mission runtime.
 *
 * Postgres is the source of truth. Redis/BullMQ only coordinates AgentRun execution.
 * All mutating paths use $transaction so Phase 12B outbox can attach atomically.
 * Never store private chain-of-thought — only operational summaries / evidence / decisions.
 */

import {
  MissionErrorClass,
  MissionExternalOutcome,
  MissionStatus,
  MissionTaskStatus,
  type AgentMission,
  type MissionTask,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertMissionTransition,
  assertTaskTransition,
  isTerminalMissionStatus,
} from "@/services/mission-state";
import { prepareDomainEventAttach } from "@/services/domain-events/append";

export { prepareDomainEventAttach } from "@/services/domain-events/append";

export class MissionNotFoundError extends Error {
  readonly code = "MISSION_NOT_FOUND";
  constructor() {
    super("Mission not found for organisation");
    this.name = "MissionNotFoundError";
  }
}

export class MissionPermissionError extends Error {
  readonly code = "MISSION_PERMISSION";
  constructor(message = "Permission denied for mission operation") {
    super(message);
    this.name = "MissionPermissionError";
  }
}

export class MissionBudgetExceededError extends Error {
  readonly code = "MISSION_BUDGET";
  constructor() {
    super("Mission budget exhausted");
    this.name = "MissionBudgetExceededError";
  }
}

export class MissionDuplicateDeliveryError extends Error {
  readonly code = "MISSION_DUPLICATE_DELIVERY";
  constructor(public readonly idempotencyKey: string) {
    super(`Duplicate task delivery for idempotency key ${idempotencyKey}`);
    this.name = "MissionDuplicateDeliveryError";
  }
}

export type CreateMissionInput = {
  organisationId: string;
  title: string;
  objectiveSummary: string;
  createdByUserId?: string;
  goalId?: string;
  priority?: number;
  budgetCents?: number;
  deadlineAt?: Date;
  planSummary?: string;
  tasks: Array<{
    idempotencyKey: string;
    title: string;
    description?: string;
    priority?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    deadlineAt?: Date;
    budgetCents?: number;
    assignedAgent?: string;
    assignedAgentVersion?: string;
    /** Idempotency keys of tasks this one depends on */
    dependsOnKeys?: string[];
  }>;
};

export async function createMission(input: CreateMissionInput): Promise<AgentMission> {
  if (!input.tasks.length) {
    throw new Error("Mission requires at least one task");
  }

  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.create({
      data: {
        organisationId: input.organisationId,
        title: input.title,
        objectiveSummary: input.objectiveSummary,
        createdByUserId: input.createdByUserId,
        goalId: input.goalId,
        priority: input.priority ?? 100,
        budgetCents: input.budgetCents,
        deadlineAt: input.deadlineAt,
        planSummary: input.planSummary,
        status: MissionStatus.QUEUED,
      },
    });

    const keyToId = new Map<string, string>();
    for (const t of input.tasks) {
      const task = await tx.missionTask.create({
        data: {
          organisationId: input.organisationId,
          missionId: mission.id,
          idempotencyKey: t.idempotencyKey,
          title: t.title,
          description: t.description,
          priority: t.priority ?? 100,
          maxAttempts: t.maxAttempts ?? 3,
          timeoutMs: t.timeoutMs ?? 300_000,
          deadlineAt: t.deadlineAt,
          budgetCents: t.budgetCents,
          assignedAgent: t.assignedAgent,
          assignedAgentVersion: t.assignedAgentVersion,
          status: MissionTaskStatus.PENDING,
        },
      });
      keyToId.set(t.idempotencyKey, task.id);
    }

    for (const t of input.tasks) {
      const taskId = keyToId.get(t.idempotencyKey)!;
      for (const depKey of t.dependsOnKeys ?? []) {
        const dependsOnTaskId = keyToId.get(depKey);
        if (!dependsOnTaskId) {
          throw new Error(`Unknown dependency key: ${depKey}`);
        }
        await tx.missionTaskDependency.create({
          data: {
            organisationId: input.organisationId,
            missionId: mission.id,
            taskId,
            dependsOnTaskId,
          },
        });
      }
    }

    await markReadyTasks(tx, input.organisationId, mission.id);

    await prepareDomainEventAttach(tx, {
      organisationId: input.organisationId,
      aggregateType: "AgentMission",
      aggregateId: mission.id,
      eventType: "mission.created",
      payload: { title: input.title, taskCount: input.tasks.length },
    });

    return mission;
  });
}

async function markReadyTasks(
  tx: Prisma.TransactionClient,
  organisationId: string,
  missionId: string,
): Promise<void> {
  const tasks = await tx.missionTask.findMany({
    where: { organisationId, missionId },
    include: { dependsOn: true },
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    if (task.status !== MissionTaskStatus.PENDING) continue;
    const deps = task.dependsOn;
    const allDone = deps.every((d) => {
      const parent = byId.get(d.dependsOnTaskId);
      return parent?.status === MissionTaskStatus.COMPLETED;
    });
    if (deps.length === 0 || allDone) {
      assertTaskTransition(task.status, MissionTaskStatus.READY);
      await tx.missionTask.update({
        where: { id: task.id },
        data: { status: MissionTaskStatus.READY },
      });
    }
  }
}

export async function getMissionForOrg(organisationId: string, missionId: string) {
  const mission = await prisma.agentMission.findFirst({
    where: { id: missionId, organisationId },
    include: {
      tasks: { include: { dependsOn: true }, orderBy: { priority: "asc" } },
      checkpoints: { orderBy: { createdAt: "desc" }, take: 20 },
      artifacts: true,
      outcomes: true,
    },
  });
  if (!mission) throw new MissionNotFoundError();
  return mission;
}

export async function transitionMissionStatus(input: {
  organisationId: string;
  missionId: string;
  to: MissionStatus;
  errorClass?: MissionErrorClass;
  errorMessage?: string;
  decisionSummary?: string;
  confidence?: number;
}): Promise<AgentMission> {
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findFirst({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    if (!mission) throw new MissionNotFoundError();
    assertMissionTransition(mission.status, input.to);

    const data: Prisma.AgentMissionUpdateInput = {
      status: input.to,
      lastErrorClass: input.errorClass ?? mission.lastErrorClass,
      lastErrorMessage: input.errorMessage ?? mission.lastErrorMessage,
      decisionSummary: input.decisionSummary ?? mission.decisionSummary,
      confidence: input.confidence ?? mission.confidence,
    };
    if (input.to === MissionStatus.RUNNING && !mission.startedAt) {
      data.startedAt = new Date();
    }
    if (isTerminalMissionStatus(input.to)) {
      data.finishedAt = new Date();
      if (input.to === MissionStatus.CANCELLED) data.cancelledAt = new Date();
    }

    const updated = await tx.agentMission.update({
      where: { id: mission.id },
      data,
    });

    await prepareDomainEventAttach(tx, {
      organisationId: input.organisationId,
      aggregateType: "AgentMission",
      aggregateId: mission.id,
      eventType: `mission.status.${input.to}`,
      payload: { from: mission.status, to: input.to },
    });

    return updated;
  });
}

/**
 * Claim next READY task respecting dependency order and idempotency.
 * Duplicate claim of the same (mission, idempotencyKey, attempt) is rejected.
 */
export async function claimNextTask(input: {
  organisationId: string;
  missionId: string;
}): Promise<MissionTask | null> {
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findFirst({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    if (!mission) throw new MissionNotFoundError();
    if (
      mission.status === MissionStatus.CANCELLED ||
      mission.status === MissionStatus.COMPLETED ||
      mission.status === MissionStatus.FAILED ||
      mission.status === MissionStatus.WAITING_APPROVAL ||
      mission.status === MissionStatus.BLOCKED
    ) {
      return null;
    }
    if (mission.budgetCents != null && mission.spentCents >= mission.budgetCents) {
      throw new MissionBudgetExceededError();
    }
    if (mission.deadlineAt && mission.deadlineAt < new Date()) {
      assertMissionTransition(mission.status, MissionStatus.FAILED);
      await tx.agentMission.update({
        where: { id: mission.id },
        data: {
          status: MissionStatus.FAILED,
          lastErrorClass: MissionErrorClass.TIMEOUT,
          lastErrorMessage: "Mission deadline exceeded",
          finishedAt: new Date(),
        },
      });
      return null;
    }

    await markReadyTasks(tx, input.organisationId, input.missionId);

    const task = await tx.missionTask.findFirst({
      where: {
        organisationId: input.organisationId,
        missionId: input.missionId,
        status: MissionTaskStatus.READY,
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    if (!task) return null;

    if (task.attempt >= task.maxAttempts) {
      assertTaskTransition(task.status, MissionTaskStatus.FAILED);
      await tx.missionTask.update({
        where: { id: task.id },
        data: {
          status: MissionTaskStatus.FAILED,
          errorClass: MissionErrorClass.UNKNOWN,
          lastError: "Max attempts exceeded",
          finishedAt: new Date(),
        },
      });
      return null;
    }

    assertTaskTransition(task.status, MissionTaskStatus.RUNNING);
    const nextAttempt = task.attempt + 1;
    // Compare-and-swap: exactly one concurrent worker wins the claim.
    const cas = await tx.missionTask.updateMany({
      where: {
        id: task.id,
        organisationId: input.organisationId,
        missionId: input.missionId,
        status: MissionTaskStatus.READY,
      },
      data: {
        status: MissionTaskStatus.RUNNING,
        attempt: nextAttempt,
        startedAt: task.startedAt ?? new Date(),
        errorClass: MissionErrorClass.NONE,
        lastError: null,
      },
    });
    if (cas.count !== 1) {
      return null; // lost race — duplicate delivery safely no-ops
    }
    const claimed = await tx.missionTask.findFirstOrThrow({ where: { id: task.id } });

    if (mission.status === MissionStatus.QUEUED || mission.status === MissionStatus.PLANNING) {
      assertMissionTransition(mission.status, MissionStatus.RUNNING);
      await tx.agentMission.update({
        where: { id: mission.id },
        data: { status: MissionStatus.RUNNING, startedAt: mission.startedAt ?? new Date() },
      });
    } else if (mission.status === MissionStatus.WAITING || mission.status === MissionStatus.RETRYING) {
      assertMissionTransition(mission.status, MissionStatus.RUNNING);
      await tx.agentMission.update({
        where: { id: mission.id },
        data: { status: MissionStatus.RUNNING },
      });
    }

    await tx.missionCheckpoint.create({
      data: {
        organisationId: input.organisationId,
        missionId: input.missionId,
        taskId: claimed.id,
        label: "task.claimed",
        payload: {
          taskId: claimed.id,
          idempotencyKey: claimed.idempotencyKey,
          attempt: claimed.attempt,
        },
      },
    });

    await tx.agentMission.update({
      where: { id: mission.id },
      data: {
        resumeCursor: {
          taskId: claimed.id,
          idempotencyKey: claimed.idempotencyKey,
          attempt: claimed.attempt,
        },
      },
    });

    return claimed;
  });
}

/**
 * Mark consequential external work state. CONFIRMED must not be blindly replayed after crash.
 */
export async function setTaskExternalOutcome(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
  outcome: MissionExternalOutcome;
}): Promise<MissionTask> {
  const task = await prisma.missionTask.findFirst({
    where: {
      id: input.taskId,
      missionId: input.missionId,
      organisationId: input.organisationId,
    },
  });
  if (!task) throw new MissionNotFoundError();
  return prisma.missionTask.update({
    where: { id: task.id },
    data: { externalOutcome: input.outcome },
  });
}

/**
 * Idempotent complete: same (idempotencyKey, attempt) completing twice is a no-op success.
 */
export async function completeTask(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
  attempt: number;
  resultSummary?: string;
  spentCents?: number;
}): Promise<MissionTask> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
      },
    });
    if (!task) throw new MissionNotFoundError();

    if (task.status === MissionTaskStatus.COMPLETED && task.attempt === input.attempt) {
      return task; // idempotent retry / duplicate delivery
    }

    if (task.status === MissionTaskStatus.COMPLETED) {
      throw new MissionDuplicateDeliveryError(task.idempotencyKey);
    }

    if (task.attempt !== input.attempt) {
      throw new MissionDuplicateDeliveryError(task.idempotencyKey);
    }

    assertTaskTransition(task.status, MissionTaskStatus.COMPLETED);
    const updated = await tx.missionTask.update({
      where: { id: task.id },
      data: {
        status: MissionTaskStatus.COMPLETED,
        resultSummary: input.resultSummary,
        spentCents: task.spentCents + (input.spentCents ?? 0),
        finishedAt: new Date(),
        errorClass: MissionErrorClass.NONE,
        lastError: null,
      },
    });

    if (input.spentCents) {
      await tx.agentMission.update({
        where: { id: input.missionId },
        data: { spentCents: { increment: input.spentCents } },
      });
    }

    await markReadyTasks(tx, input.organisationId, input.missionId);
    await maybeCompleteMission(tx, input.organisationId, input.missionId);
    return updated;
  });
}

async function maybeCompleteMission(
  tx: Prisma.TransactionClient,
  organisationId: string,
  missionId: string,
) {
  const tasks = await tx.missionTask.findMany({ where: { organisationId, missionId } });
  const allDone = tasks.every(
    (t) =>
      t.status === MissionTaskStatus.COMPLETED ||
      t.status === MissionTaskStatus.SKIPPED ||
      t.status === MissionTaskStatus.CANCELLED,
  );
  const anyFailed = tasks.some((t) => t.status === MissionTaskStatus.FAILED);
  const mission = await tx.agentMission.findFirstOrThrow({
    where: { id: missionId, organisationId },
  });

  if (anyFailed && tasks.every((t) => isTerminalTaskLike(t.status))) {
    assertMissionTransition(mission.status, MissionStatus.FAILED);
    await tx.agentMission.update({
      where: { id: missionId },
      data: {
        status: MissionStatus.FAILED,
        finishedAt: new Date(),
        lastErrorClass: MissionErrorClass.TOOL_FAILED,
      },
    });
    await tx.missionOutcome.create({
      data: {
        organisationId,
        missionId,
        kind: "failed",
        summary: "One or more tasks failed",
      },
    });
    return;
  }

  if (allDone) {
    assertMissionTransition(mission.status, MissionStatus.COMPLETED);
    await tx.agentMission.update({
      where: { id: missionId },
      data: { status: MissionStatus.COMPLETED, finishedAt: new Date() },
    });
    await tx.missionOutcome.create({
      data: {
        organisationId,
        missionId,
        kind: "success",
        summary: mission.planSummary || mission.objectiveSummary,
        confidence: mission.confidence,
      },
    });
  }
}

function isTerminalTaskLike(status: MissionTaskStatus): boolean {
  return (
    status === MissionTaskStatus.COMPLETED ||
    status === MissionTaskStatus.FAILED ||
    status === MissionTaskStatus.CANCELLED ||
    status === MissionTaskStatus.SKIPPED
  );
}

export async function failTask(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
  attempt: number;
  errorClass: MissionErrorClass;
  errorMessage: string;
}): Promise<MissionTask> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
      },
    });
    if (!task) throw new MissionNotFoundError();
    if (task.attempt !== input.attempt) {
      throw new MissionDuplicateDeliveryError(task.idempotencyKey);
    }

    const canRetry =
      task.attempt < task.maxAttempts &&
      (input.errorClass === MissionErrorClass.TRANSIENT ||
        input.errorClass === MissionErrorClass.RATE_LIMIT ||
        input.errorClass === MissionErrorClass.TIMEOUT ||
        input.errorClass === MissionErrorClass.PROVIDER_OUTAGE);

    if (canRetry) {
      assertTaskTransition(task.status, MissionTaskStatus.RETRYING);
      assertTaskTransition(MissionTaskStatus.RETRYING, MissionTaskStatus.READY);
      const updated = await tx.missionTask.update({
        where: { id: task.id },
        data: {
          status: MissionTaskStatus.READY,
          errorClass: input.errorClass,
          lastError: input.errorMessage,
        },
      });
      const mission = await tx.agentMission.findFirstOrThrow({
        where: { id: input.missionId },
      });
      if (mission.status === MissionStatus.RUNNING) {
        assertMissionTransition(mission.status, MissionStatus.RETRYING);
        await tx.agentMission.update({
          where: { id: mission.id },
          data: {
            status: MissionStatus.RETRYING,
            lastErrorClass: input.errorClass,
            lastErrorMessage: input.errorMessage,
          },
        });
      }
      return updated;
    }

    assertTaskTransition(task.status, MissionTaskStatus.FAILED);
    const updated = await tx.missionTask.update({
      where: { id: task.id },
      data: {
        status: MissionTaskStatus.FAILED,
        errorClass: input.errorClass,
        lastError: input.errorMessage,
        finishedAt: new Date(),
      },
    });
    await maybeCompleteMission(tx, input.organisationId, input.missionId);
    return updated;
  });
}

export class MissionApprovalRequiredError extends Error {
  readonly code = "MISSION_APPROVAL_REQUIRED";
  constructor(message = "Mission task requires an explicit approval before resume") {
    super(message);
    this.name = "MissionApprovalRequiredError";
  }
}

export class MissionApprovalRejectedError extends Error {
  readonly code = "MISSION_APPROVAL_REJECTED";
  constructor(message = "Mission task approval was rejected") {
    super(message);
    this.name = "MissionApprovalRejectedError";
  }
}

export async function waitForApproval(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
      },
    });
    if (!task) throw new MissionNotFoundError();
    assertTaskTransition(task.status, MissionTaskStatus.WAITING_APPROVAL);
    await tx.missionTask.update({
      where: { id: task.id },
      data: {
        status: MissionTaskStatus.WAITING_APPROVAL,
        approvedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        approvalUserId: null,
      },
    });
    const mission = await tx.agentMission.findFirstOrThrow({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    assertMissionTransition(mission.status, MissionStatus.WAITING_APPROVAL);
    await tx.agentMission.update({
      where: { id: mission.id },
      data: { status: MissionStatus.WAITING_APPROVAL },
    });
  });
}

/** Record human approval — required before resumeAfterApproval. */
export async function approveMissionTask(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
  approverUserId: string;
}): Promise<MissionTask> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
        status: MissionTaskStatus.WAITING_APPROVAL,
      },
    });
    if (!task) throw new MissionNotFoundError();
    return tx.missionTask.update({
      where: { id: task.id },
      data: {
        approvalUserId: input.approverUserId,
        approvedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
      },
    });
  });
}

export async function rejectMissionTask(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
  approverUserId: string;
  reason: string;
}): Promise<MissionTask> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
        status: MissionTaskStatus.WAITING_APPROVAL,
      },
    });
    if (!task) throw new MissionNotFoundError();
    assertTaskTransition(task.status, MissionTaskStatus.FAILED);
    const updated = await tx.missionTask.update({
      where: { id: task.id },
      data: {
        status: MissionTaskStatus.FAILED,
        approvalUserId: input.approverUserId,
        rejectedAt: new Date(),
        rejectionReason: input.reason,
        approvedAt: null,
        errorClass: MissionErrorClass.PERMISSION,
        lastError: input.reason,
        finishedAt: new Date(),
      },
    });
    const mission = await tx.agentMission.findFirstOrThrow({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    assertMissionTransition(mission.status, MissionStatus.FAILED);
    await tx.agentMission.update({
      where: { id: mission.id },
      data: {
        status: MissionStatus.FAILED,
        lastErrorClass: MissionErrorClass.PERMISSION,
        lastErrorMessage: input.reason,
        finishedAt: new Date(),
      },
    });
    await tx.missionOutcome.create({
      data: {
        organisationId: input.organisationId,
        missionId: input.missionId,
        kind: "failed",
        summary: `Approval rejected: ${input.reason}`,
      },
    });
    return updated;
  });
}

/**
 * Resume only after approveMissionTask. Cannot bypass WAITING_APPROVAL.
 * Downstream consequential tasks stay blocked while mission is WAITING_APPROVAL
 * (claimNextTask returns null).
 */
export async function resumeAfterApproval(input: {
  organisationId: string;
  missionId: string;
  taskId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await tx.missionTask.findFirst({
      where: {
        id: input.taskId,
        missionId: input.missionId,
        organisationId: input.organisationId,
      },
    });
    if (!task) throw new MissionNotFoundError();
    if (task.status !== MissionTaskStatus.WAITING_APPROVAL) {
      throw new MissionApprovalRequiredError(`Task is ${task.status}, not WAITING_APPROVAL`);
    }
    if (task.rejectedAt) {
      throw new MissionApprovalRejectedError(task.rejectionReason || "rejected");
    }
    if (!task.approvedAt || !task.approvalUserId) {
      throw new MissionApprovalRequiredError();
    }
    assertTaskTransition(task.status, MissionTaskStatus.READY);
    await tx.missionTask.update({
      where: { id: task.id },
      data: { status: MissionTaskStatus.READY },
    });
    const mission = await tx.agentMission.findFirstOrThrow({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    assertMissionTransition(mission.status, MissionStatus.RUNNING);
    await tx.agentMission.update({
      where: { id: mission.id },
      data: { status: MissionStatus.RUNNING },
    });
  });
}

/**
 * Recover after worker crash without blindly replaying confirmed external work.
 * - CONFIRMED → complete task (no re-dispatch)
 * - DISPATCHING → RECONCILIATION_REQUIRED + BLOCKED
 * - otherwise → READY for safe retry
 */
export async function resumeAfterWorkerCrash(input: {
  organisationId: string;
  missionId: string;
}): Promise<MissionTask | null> {
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findFirst({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    if (!mission) throw new MissionNotFoundError();

    const stuck = await tx.missionTask.findMany({
      where: {
        organisationId: input.organisationId,
        missionId: input.missionId,
        status: MissionTaskStatus.RUNNING,
      },
    });

    let first: MissionTask | null = null;
    for (const task of stuck) {
      if (task.externalOutcome === MissionExternalOutcome.CONFIRMED) {
        assertTaskTransition(task.status, MissionTaskStatus.COMPLETED);
        first = await tx.missionTask.update({
          where: { id: task.id },
          data: {
            status: MissionTaskStatus.COMPLETED,
            resultSummary: task.resultSummary || "Confirmed before crash — not replayed",
            finishedAt: new Date(),
            lastError: null,
          },
        });
        await tx.missionCheckpoint.create({
          data: {
            organisationId: input.organisationId,
            missionId: input.missionId,
            taskId: task.id,
            label: "resume.after_crash.confirmed",
            payload: {
              taskId: task.id,
              externalOutcome: task.externalOutcome,
              attempt: task.attempt,
            },
          },
        });
        await maybeCompleteMission(tx, input.organisationId, input.missionId);
        continue;
      }

      if (task.externalOutcome === MissionExternalOutcome.DISPATCHING) {
        assertTaskTransition(task.status, MissionTaskStatus.BLOCKED);
        first = await tx.missionTask.update({
          where: { id: task.id },
          data: {
            status: MissionTaskStatus.BLOCKED,
            externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
            errorClass: MissionErrorClass.UNKNOWN,
            lastError: "External dispatch in progress at crash — reconciliation required",
          },
        });
        await tx.missionCheckpoint.create({
          data: {
            organisationId: input.organisationId,
            missionId: input.missionId,
            taskId: task.id,
            label: "resume.after_crash.reconcile",
            payload: {
              taskId: task.id,
              externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
              attempt: task.attempt,
            },
          },
        });
        if (mission.status === MissionStatus.RUNNING) {
          assertMissionTransition(mission.status, MissionStatus.BLOCKED);
          await tx.agentMission.update({
            where: { id: mission.id },
            data: {
              status: MissionStatus.BLOCKED,
              lastErrorClass: MissionErrorClass.UNKNOWN,
              lastErrorMessage: "Reconciliation required after crash mid-dispatch",
            },
          });
        }
        continue;
      }

      assertTaskTransition(task.status, MissionTaskStatus.READY);
      first = await tx.missionTask.update({
        where: { id: task.id },
        data: {
          status: MissionTaskStatus.READY,
          errorClass: MissionErrorClass.TRANSIENT,
          lastError: "Resumed after worker crash",
        },
      });
      await tx.missionCheckpoint.create({
        data: {
          organisationId: input.organisationId,
          missionId: input.missionId,
          taskId: task.id,
          label: "resume.after_crash",
          payload: {
            taskId: task.id,
            idempotencyKey: task.idempotencyKey,
            attempt: task.attempt,
            externalOutcome: task.externalOutcome,
          },
        },
      });
    }

    const refreshed = await tx.agentMission.findFirstOrThrow({ where: { id: mission.id } });
    if (
      stuck.some((t) => t.externalOutcome === MissionExternalOutcome.NOT_STARTED) &&
      refreshed.status === MissionStatus.RUNNING
    ) {
      assertMissionTransition(refreshed.status, MissionStatus.RETRYING);
      await tx.agentMission.update({
        where: { id: mission.id },
        data: { status: MissionStatus.RETRYING },
      });
    }

    return first;
  });
}

export async function cancelMission(input: {
  organisationId: string;
  missionId: string;
}): Promise<AgentMission> {
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findFirst({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    if (!mission) throw new MissionNotFoundError();
    assertMissionTransition(mission.status, MissionStatus.CANCELLED);

    await tx.missionTask.updateMany({
      where: {
        missionId: mission.id,
        organisationId: input.organisationId,
        status: {
          in: [
            MissionTaskStatus.PENDING,
            MissionTaskStatus.READY,
            MissionTaskStatus.RUNNING,
            MissionTaskStatus.WAITING,
            MissionTaskStatus.WAITING_APPROVAL,
            MissionTaskStatus.BLOCKED,
            MissionTaskStatus.RETRYING,
          ],
        },
      },
      data: {
        status: MissionTaskStatus.CANCELLED,
        errorClass: MissionErrorClass.CANCELLED,
        finishedAt: new Date(),
      },
    });

    const updated = await tx.agentMission.update({
      where: { id: mission.id },
      data: {
        status: MissionStatus.CANCELLED,
        cancelledAt: new Date(),
        finishedAt: new Date(),
        lastErrorClass: MissionErrorClass.CANCELLED,
      },
    });

    await tx.missionOutcome.create({
      data: {
        organisationId: input.organisationId,
        missionId: mission.id,
        kind: "cancelled",
        summary: "Mission cancelled",
      },
    });

    return updated;
  });
}

export async function stopMissionOnBudget(input: {
  organisationId: string;
  missionId: string;
}): Promise<AgentMission> {
  return prisma.$transaction(async (tx) => {
    const mission = await tx.agentMission.findFirst({
      where: { id: input.missionId, organisationId: input.organisationId },
    });
    if (!mission) throw new MissionNotFoundError();
    assertMissionTransition(mission.status, MissionStatus.FAILED);
    return tx.agentMission.update({
      where: { id: mission.id },
      data: {
        status: MissionStatus.FAILED,
        lastErrorClass: MissionErrorClass.BUDGET,
        lastErrorMessage: "Budget stop",
        finishedAt: new Date(),
      },
    });
  });
}

/**
 * Redis unavailability must not erase durable mission rows.
 * This helper only reads Postgres — used by tests to assert survival.
 */
export async function loadMissionDurableState(organisationId: string, missionId: string) {
  return getMissionForOrg(organisationId, missionId);
}

export async function assertMissionTenantIsolation(input: {
  organisationId: string;
  otherOrganisationId: string;
  missionId: string;
}): Promise<"ok"> {
  const cross = await prisma.agentMission.findFirst({
    where: { id: input.missionId, organisationId: input.otherOrganisationId },
  });
  if (cross) throw new Error("Tenant isolation broken — mission visible to other org");
  try {
    await getMissionForOrg(input.otherOrganisationId, input.missionId);
    throw new Error("Expected MissionNotFoundError");
  } catch (e) {
    if (!(e instanceof MissionNotFoundError)) throw e;
  }
  await getMissionForOrg(input.organisationId, input.missionId);
  return "ok";
}

export function rejectMissionPermission(allowed: boolean): void {
  if (!allowed) throw new MissionPermissionError();
}
