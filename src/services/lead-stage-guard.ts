/**
 * Rules for when the AI operator may change a lead's pipeline stage or qualification.
 *
 * A person's decision wins: once someone moves a lead or sets its qualification by hand,
 * inbound AI analysis stops overwriting it. The AI also never drags a lead backwards
 * (e.g. Booked → Engaged because the customer said "thanks") or out of a won/booked stage.
 */

export type StageLike = {
  id: string;
  slug: string;
  position: number;
  isWon?: boolean | null;
  isLost?: boolean | null;
};

type Meta = Record<string, unknown>;

export function readLeadMeta(metadata: unknown): Meta {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Meta)
    : {};
}

/** Lead metadata after a person changes stage and/or qualification. */
export function markHumanLeadChange(
  metadata: unknown,
  change: { stage?: boolean; qualification?: boolean; userId?: string | null },
  now = new Date(),
): Meta {
  const next: Meta = { ...readLeadMeta(metadata) };
  if (change.stage) {
    next.stageChangedBy = "HUMAN";
    next.stageChangedAt = now.toISOString();
    if (change.userId) next.stageChangedByUserId = change.userId;
  }
  if (change.qualification) {
    next.qualificationSetBy = "HUMAN";
    next.qualificationSetAt = now.toISOString();
  }
  return next;
}

function isLockedStage(stage: StageLike): boolean {
  return Boolean(stage.isWon) || stage.slug === "booked" || stage.slug === "won";
}

/** May inbound AI analysis move this lead from `current` to `target`? */
export function aiMayMoveStage(input: {
  current: StageLike | null | undefined;
  target: StageLike | null | undefined;
  metadata: unknown;
}): boolean {
  const { current, target } = input;
  if (!target) return false;
  if (!current) return true;
  if (current.id === target.id) return false;
  const meta = readLeadMeta(input.metadata);
  if (meta.stageChangedBy === "HUMAN") return false;
  if (isLockedStage(current)) return false;
  // A lost lead the AI itself disqualified may be re-engaged when they write back.
  if (current.isLost) return !target.isLost;
  return target.position > current.position;
}

/** May inbound AI analysis overwrite the lead's qualification status? */
export function aiMaySetQualification(metadata: unknown): boolean {
  return readLeadMeta(metadata).qualificationSetBy !== "HUMAN";
}
