import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MissionErrorClass, MissionStatus, MissionTaskStatus } from "@prisma/client";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";
import {
  assertMissionTenantIsolation,
  approveMissionTask,
  cancelMission,
  claimNextTask,
  completeTask,
  createMission,
  failTask,
  getMissionForOrg,
  loadMissionDurableState,
  MissionApprovalRequiredError,
  MissionBudgetExceededError,
  MissionNotFoundError,
  MissionPermissionError,
  rejectMissionPermission,
  rejectMissionTask,
  resumeAfterApproval,
  resumeAfterWorkerCrash,
  setTaskExternalOutcome,
  stopMissionOnBudget,
  waitForApproval,
} from "@/services/mission-runtime";
import { assertMissionTransition, InvalidMissionTransitionError } from "@/services/mission-state";
import { prisma } from "@/lib/db";
import { MissionExternalOutcome } from "@prisma/client";

describe("Phase 12 Mission runtime", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;

  beforeAll(async () => {
    orgA = await createTestOrganisation("mission-a");
    orgB = await createTestOrganisation("mission-b");
  });

  afterAll(async () => {
    await destroyTestOrganisation(orgA);
    await destroyTestOrganisation(orgB);
  });

  it("creates a mission with dependency ordering", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Dep order",
      objectiveSummary: "Research then draft",
      planSummary: "Two-step plan",
      tasks: [
        { idempotencyKey: "research", title: "Research", priority: 1 },
        {
          idempotencyKey: "draft",
          title: "Draft",
          priority: 2,
          dependsOnKeys: ["research"],
        },
      ],
    });

    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.status).toBe(MissionStatus.QUEUED);
    const research = loaded.tasks.find((t) => t.idempotencyKey === "research")!;
    const draft = loaded.tasks.find((t) => t.idempotencyKey === "draft")!;
    expect(research.status).toBe(MissionTaskStatus.READY);
    expect(draft.status).toBe(MissionTaskStatus.PENDING);

    const first = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(first?.idempotencyKey).toBe("research");
    await completeTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: first!.id,
      attempt: first!.attempt,
      resultSummary: "Findings ready",
    });

    const second = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(second?.idempotencyKey).toBe("draft");
  });

  it("resumes after simulated worker crash", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Crash resume",
      objectiveSummary: "Survive crash",
      tasks: [{ idempotencyKey: "only", title: "Only task" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(claimed?.status).toBe(MissionTaskStatus.RUNNING);

    await resumeAfterWorkerCrash({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    const after = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(after.status).toBe(MissionStatus.RETRYING);
    expect(after.tasks[0].status).toBe(MissionTaskStatus.READY);
    expect(after.checkpoints.some((c) => c.label === "resume.after_crash")).toBe(true);

    const again = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(again?.attempt).toBe(2);
    await completeTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: again!.id,
      attempt: again!.attempt,
    });
  });

  it("idempotent complete and duplicate-delivery protection", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Idempotent",
      objectiveSummary: "Complete once",
      tasks: [{ idempotencyKey: "t1", title: "T1" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await completeTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      attempt: claimed!.attempt,
      resultSummary: "done",
    });
    const again = await completeTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      attempt: claimed!.attempt,
      resultSummary: "done",
    });
    expect(again.status).toBe(MissionTaskStatus.COMPLETED);

    await expect(
      completeTask({
        organisationId: orgA.organisationId,
        missionId: mission.id,
        taskId: claimed!.id,
        attempt: claimed!.attempt + 1,
      }),
    ).rejects.toMatchObject({ code: "MISSION_DUPLICATE_DELIVERY" });
  });

  it("cancels a mission", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Cancel me",
      objectiveSummary: "Stop",
      tasks: [
        { idempotencyKey: "a", title: "A" },
        { idempotencyKey: "b", title: "B", dependsOnKeys: ["a"] },
      ],
    });
    const cancelled = await cancelMission({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(cancelled.status).toBe(MissionStatus.CANCELLED);
    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.tasks.every((t) => t.status === MissionTaskStatus.CANCELLED)).toBe(true);
    expect(loaded.outcomes[0]?.kind).toBe("cancelled");
  });

  it("stops on budget", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Budget",
      objectiveSummary: "Cap",
      budgetCents: 10,
      tasks: [{ idempotencyKey: "b1", title: "B1" }],
    });
    await prisma.agentMission.update({
      where: { id: mission.id },
      data: { spentCents: 10, status: MissionStatus.RUNNING, startedAt: new Date() },
    });
    await expect(
      claimNextTask({ organisationId: orgA.organisationId, missionId: mission.id }),
    ).rejects.toBeInstanceOf(MissionBudgetExceededError);

    const stopped = await stopMissionOnBudget({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    expect(stopped.lastErrorClass).toBe(MissionErrorClass.BUDGET);
  });

  it("handles timeout classification and rate limit retry", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Retry",
      objectiveSummary: "Rate limit",
      tasks: [{ idempotencyKey: "r1", title: "R1", maxAttempts: 3 }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await failTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      attempt: claimed!.attempt,
      errorClass: MissionErrorClass.RATE_LIMIT,
      errorMessage: "429",
    });
    const mid = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(mid.tasks[0].status).toBe(MissionTaskStatus.READY);
    expect(mid.status).toBe(MissionStatus.RETRYING);

    const claimed2 = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await failTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed2!.id,
      attempt: claimed2!.attempt,
      errorClass: MissionErrorClass.TIMEOUT,
      errorMessage: "timeout",
    });
  });

  it("failed tool without retries marks task failed", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Tool fail",
      objectiveSummary: "Hard fail",
      tasks: [{ idempotencyKey: "f1", title: "F1", maxAttempts: 1 }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await failTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      attempt: claimed!.attempt,
      errorClass: MissionErrorClass.TOOL_FAILED,
      errorMessage: "tool exploded",
    });
    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.tasks[0].status).toBe(MissionTaskStatus.FAILED);
    expect(loaded.status).toBe(MissionStatus.FAILED);
  });

  it("WAITING_APPROVAL then approve and resume", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Approval",
      objectiveSummary: "Need human",
      tasks: [
        { idempotencyKey: "ap", title: "Approve" },
        { idempotencyKey: "after", title: "After", dependsOnKeys: ["ap"] },
      ],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await waitForApproval({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
    });
    let loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.status).toBe(MissionStatus.WAITING_APPROVAL);

    // Cannot claim downstream while waiting approval
    expect(
      await claimNextTask({ organisationId: orgA.organisationId, missionId: mission.id }),
    ).toBeNull();

    // Cannot bypass without approve
    await expect(
      resumeAfterApproval({
        organisationId: orgA.organisationId,
        missionId: mission.id,
        taskId: claimed!.id,
      }),
    ).rejects.toBeInstanceOf(MissionApprovalRequiredError);

    await approveMissionTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      approverUserId: "user_approver_1",
    });

    await resumeAfterApproval({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
    });
    loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.status).toBe(MissionStatus.RUNNING);
    expect(loaded.tasks.find((t) => t.idempotencyKey === "ap")?.approvalUserId).toBe(
      "user_approver_1",
    );
    expect(loaded.tasks.find((t) => t.idempotencyKey === "ap")?.approvedAt).toBeTruthy();
  });

  it("rejects approval and blocks downstream", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Reject",
      objectiveSummary: "No",
      tasks: [{ idempotencyKey: "r", title: "R" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await waitForApproval({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
    });
    await rejectMissionTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      approverUserId: "user_rej",
      reason: "policy",
    });
    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.status).toBe(MissionStatus.FAILED);
    expect(loaded.tasks[0].rejectedAt).toBeTruthy();
    expect(loaded.tasks[0].rejectionReason).toBe("policy");
  });

  it("duplicate concurrent claim: exactly one wins", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "CAS",
      objectiveSummary: "One winner",
      tasks: [{ idempotencyKey: "only", title: "Only" }],
    });
    const [a, b] = await Promise.all([
      claimNextTask({ organisationId: orgA.organisationId, missionId: mission.id }),
      claimNextTask({ organisationId: orgA.organisationId, missionId: mission.id }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.attempt).toBe(1);
  });

  it("crash with CONFIRMED external outcome does not replay", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Confirmed crash",
      objectiveSummary: "No replay",
      tasks: [{ idempotencyKey: "pub", title: "Publish" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await setTaskExternalOutcome({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      outcome: MissionExternalOutcome.CONFIRMED,
    });
    await resumeAfterWorkerCrash({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.tasks[0].status).toBe(MissionTaskStatus.COMPLETED);
    expect(loaded.checkpoints.some((c) => c.label === "resume.after_crash.confirmed")).toBe(true);
  }, 20_000);

  it("crash mid-DISPATCHING requires reconciliation", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Dispatch crash",
      objectiveSummary: "Reconcile",
      tasks: [{ idempotencyKey: "d", title: "D" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await setTaskExternalOutcome({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      outcome: MissionExternalOutcome.DISPATCHING,
    });
    await resumeAfterWorkerCrash({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    const loaded = await getMissionForOrg(orgA.organisationId, mission.id);
    expect(loaded.tasks[0].status).toBe(MissionTaskStatus.BLOCKED);
    expect(loaded.tasks[0].externalOutcome).toBe(MissionExternalOutcome.RECONCILIATION_REQUIRED);
    expect(loaded.status).toBe(MissionStatus.BLOCKED);
  });

  it("enforces tenant isolation", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "Tenant",
      objectiveSummary: "Private",
      tasks: [{ idempotencyKey: "x", title: "X" }],
    });
    await expect(getMissionForOrg(orgB.organisationId, mission.id)).rejects.toBeInstanceOf(
      MissionNotFoundError,
    );
    await expect(
      assertMissionTenantIsolation({
        organisationId: orgA.organisationId,
        otherOrganisationId: orgB.organisationId,
        missionId: mission.id,
      }),
    ).resolves.toBe("ok");
  });

  it("rejects permission when not allowed", () => {
    expect(() => rejectMissionPermission(false)).toThrow(MissionPermissionError);
    expect(() => rejectMissionPermission(true)).not.toThrow();
  });

  it("keeps durable state without Redis (Postgres only)", async () => {
    const mission = await createMission({
      organisationId: orgA.organisationId,
      title: "No Redis",
      objectiveSummary: "Durable",
      tasks: [{ idempotencyKey: "d1", title: "D1" }],
    });
    const claimed = await claimNextTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
    });
    await completeTask({
      organisationId: orgA.organisationId,
      missionId: mission.id,
      taskId: claimed!.id,
      attempt: claimed!.attempt,
      resultSummary: "ok",
    });
    const durable = await loadMissionDurableState(orgA.organisationId, mission.id);
    expect(durable.status).toBe(MissionStatus.COMPLETED);
    expect(durable.outcomes.length).toBeGreaterThan(0);
  });

  it("rejects invalid mission transitions", () => {
    expect(() => assertMissionTransition(MissionStatus.COMPLETED, MissionStatus.RUNNING)).toThrow(
      InvalidMissionTransitionError,
    );
  });
});
