/**
 * Phase 13A — Goal status transitions (controlled).
 */

import type { GoalStatus } from "@prisma/client";

export class InvalidGoalTransitionError extends Error {
  readonly code = "INVALID_GOAL_TRANSITION";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid Goal transition ${from} → ${to}`);
    this.name = "InvalidGoalTransitionError";
  }
}

const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["AT_RISK", "ACHIEVED", "PAUSED", "CANCELLED"],
  AT_RISK: ["ACTIVE", "ACHIEVED", "PAUSED", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  ACHIEVED: [],
  CANCELLED: [],
};

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidGoalTransitionError(from, to);
  }
}

/** ACHIEVED only allowed when evidence flag is true (KPI target met). */
export function assertGoalAchievedAllowed(evidenceMet: boolean): void {
  if (!evidenceMet) {
    throw new Error("Goal cannot be marked ACHIEVED without KPI/target evidence");
  }
}
