import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { looksLikeRawDatabaseError } from "@/lib/user-facing-errors";

export type WorkspaceAccessCode = "SESSION_ORG_INVALID" | "NO_WORKSPACE_MEMBERSHIP";

/**
 * Typed workspace/session failures — safe to show to users.
 * SESSION_ORG_INVALID → client should sign out and send the user to login.
 */
export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessCode;

  constructor(code: WorkspaceAccessCode, message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
    this.code = code;
  }
}

/**
 * Ensure the session org still exists and the user is a member.
 * Call before any AgentRun (or similar) write that FKs to Organisation.
 */
export async function assertActiveWorkspaceAccess(input: {
  userId: string;
  organisationId: string;
}): Promise<void> {
  const org = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
    select: { id: true },
  });

  if (!org) {
    throw new WorkspaceAccessError(
      "SESSION_ORG_INVALID",
      "Your workspace is no longer available. Please sign in again.",
    );
  }

  const membership = await prisma.organisationMember.findUnique({
    where: {
      organisationId_userId: {
        organisationId: input.organisationId,
        userId: input.userId,
      },
    },
    select: { id: true },
  });

  if (membership) return;

  const anyMembership = await prisma.organisationMember.findFirst({
    where: { userId: input.userId },
    select: { id: true },
  });

  if (!anyMembership) {
    throw new WorkspaceAccessError(
      "NO_WORKSPACE_MEMBERSHIP",
      "This account isn't linked to a workspace yet. Ask an admin to add you to a workspace, then sign in again.",
    );
  }

  throw new WorkspaceAccessError(
    "SESSION_ORG_INVALID",
    "Your session points to a workspace you can no longer access. Please sign in again.",
  );
}

/**
 * Map unknown errors to plain-English Ask API copy. Never returns Prisma/SQL text.
 */
export function toUserFacingAskError(error: unknown): string {
  if (error instanceof WorkspaceAccessError) return error.message;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003") {
      return "That request couldn't be saved because the workspace is missing. Please sign in again.";
    }
    if (error.code === "P2025") {
      return "I couldn't find that item in your workspace. Please refresh and try again.";
    }
    return "Something went wrong saving your request. Please try again in a moment.";
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return "That request couldn't be processed. Please try again.";
  }

  const message = error instanceof Error ? error.message : "";
  if (!message || looksLikeRawDatabaseError(message)) {
    return "Something went wrong starting that request. Please try again in a moment.";
  }

  if (
    /reference image|not awaiting|cannot be empty|worker isn't reachable|background worker/i.test(
      message,
    )
  ) {
    return message;
  }

  if (message.length > 180) {
    return "Something went wrong starting that request. Please try again in a moment.";
  }

  return message;
}
