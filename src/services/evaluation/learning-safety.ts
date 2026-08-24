/**
 * Phase 17 — Learning safety boundaries.
 * No self-editing of production application source.
 * Only versioned rankings / prompts / weights / fixtures within allowlist.
 */

import type { LearningWriteTarget } from "@/services/evaluation/types";

const ALLOWED_TARGETS: readonly LearningWriteTarget[] = [
  "prompt_weights",
  "ranking_weights",
  "versioned_config",
  "eval_fixtures",
] as const;

/** Paths / patterns that learning must never write. */
export const FORBIDDEN_LEARNING_PATHS = [
  "src/",
  "prisma/",
  "workers/",
  "node_modules/",
  ".env",
  "package.json",
  "next.config",
] as const;

export class LearningSafetyError extends Error {
  readonly code = "LEARNING_SAFETY_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "LearningSafetyError";
  }
}

export function isAllowedLearningWriteTarget(
  target: string,
): target is LearningWriteTarget {
  return (ALLOWED_TARGETS as readonly string[]).includes(target);
}

export function assertLearningWriteAllowed(target: LearningWriteTarget): void {
  if (!isAllowedLearningWriteTarget(target)) {
    throw new LearningSafetyError(
      `Learning write target not allowed: ${target}`,
    );
  }
}

/**
 * Reject attempts to treat filesystem/source paths as learning outputs.
 */
export function assertNotProductionCodePath(pathLike: string): void {
  const normalized = pathLike.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const forbidden of FORBIDDEN_LEARNING_PATHS) {
    if (
      normalized === forbidden ||
      normalized.startsWith(forbidden) ||
      normalized.includes(`/${forbidden}`)
    ) {
      throw new LearningSafetyError(
        `Learning must not self-edit production path: ${pathLike}`,
      );
    }
  }
}

export type LearningBoundarySummary = {
  maturity: "WORKING";
  allowedTargets: LearningWriteTarget[];
  forbiddenPaths: readonly string[];
  policy: string;
};

export function getLearningSafetyPolicy(): LearningBoundarySummary {
  return {
    maturity: "WORKING",
    allowedTargets: [...ALLOWED_TARGETS],
    forbiddenPaths: FORBIDDEN_LEARNING_PATHS,
    policy:
      "Learning updates versioned rankings/prompts/weights only. Never self-edit production source or migrations.",
  };
}
