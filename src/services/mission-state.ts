/**
 * Phase 12 — Mission state machine.
 * Transitions are validated; arbitrary strings are rejected.
 * Never persist private chain-of-thought — callers pass operational summaries only.
 */

import type { MissionStatus, MissionTaskStatus } from "@prisma/client";

export class InvalidMissionTransitionError extends Error {
  readonly code = "INVALID_MISSION_TRANSITION";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid mission transition ${from} → ${to}`);
    this.name = "InvalidMissionTransitionError";
  }
}

const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  QUEUED: ["PLANNING", "RUNNING", "CANCELLED"],
  PLANNING: ["RUNNING", "WAITING", "WAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAITING",
    "WAITING_APPROVAL",
    "BLOCKED",
    "RETRYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  WAITING: ["RUNNING", "WAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  BLOCKED: ["RUNNING", "RETRYING", "FAILED", "CANCELLED"],
  RETRYING: ["RUNNING", "WAITING", "BLOCKED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["QUEUED", "RETRYING"], // explicit re-queue only
  CANCELLED: [],
};

const TASK_TRANSITIONS: Record<MissionTaskStatus, readonly MissionTaskStatus[]> = {
  PENDING: ["READY", "CANCELLED", "SKIPPED"],
  READY: ["RUNNING", "WAITING", "WAITING_APPROVAL", "BLOCKED", "CANCELLED", "SKIPPED"],
  RUNNING: [
    "WAITING",
    "WAITING_APPROVAL",
    "BLOCKED",
    "RETRYING",
    "READY", // reclaim after worker crash
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  WAITING: ["READY", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  WAITING_APPROVAL: ["READY", "RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  BLOCKED: ["READY", "RETRYING", "FAILED", "CANCELLED"],
  RETRYING: ["READY", "RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["READY", "RETRYING"],
  CANCELLED: [],
  SKIPPED: [],
};

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (from === to) return;
  const allowed = MISSION_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidMissionTransitionError(from, to);
  }
}

export function assertTaskTransition(from: MissionTaskStatus, to: MissionTaskStatus): void {
  if (from === to) return;
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidMissionTransitionError(`task:${from}`, `task:${to}`);
  }
}

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export function isTerminalTaskStatus(status: MissionTaskStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "SKIPPED"
  );
}
