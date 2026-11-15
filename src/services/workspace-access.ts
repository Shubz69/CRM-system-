import { Prisma, type MemberRole } from "@prisma/client";
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

export const WORKSPACE_SUSPENDED_MESSAGE =
  "This workspace has been suspended. Please contact your workspace owner or Agent Desk support.";

/**
 * Ensure the session org still exists, is not suspended, and the user is a member.
 * Call before any AgentRun (or similar) write that FKs to Organisation.
 */
export async function assertActiveWorkspaceAccess(input: {
  userId: string;
  organisationId: string;
}): Promise<{ role: MemberRole }> {
  const org = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
    select: { id: true, status: true },
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
    select: {
      id: true,
      role: true,
      user: {
        select: { isActive: true, isSuspended: true, deletedAt: true, isPlatformAdmin: true },
      },
    },
  });

  if (membership) {
    // Suspended / deactivated / deleted users lose access on their next request,
    // not when their 30-day JWT happens to expire.
    if (!membership.user.isActive || membership.user.isSuspended || membership.user.deletedAt) {
      throw new WorkspaceAccessError(
        "SESSION_ORG_INVALID",
        "This account is no longer active. Please contact your workspace admin.",
      );
    }
    // A suspended workspace locks its members out on their next request (the JWT recheck
    // alone took up to 5 minutes). Platform admins keep access so they can manage it.
    if (org.status === "SUSPENDED" && !membership.user.isPlatformAdmin) {
      throw new WorkspaceAccessError("SESSION_ORG_INVALID", WORKSPACE_SUSPENDED_MESSAGE);
    }
    // Live role: a demotion takes effect immediately instead of after the JWT recheck.
    return { role: membership.role };
  }

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
 * Whether the signed-in user can use the workspace their session points at — the same
 * check every API request makes. A missing workspace or a membership/suspension refusal is
 * "no"; a database error is treated as "yes" so a blip never locks people out of the app
 * shell (the API routes still enforce access on every call).
 */
export async function hasUsableWorkspace(input: {
  userId: string;
  organisationId?: string | null;
}): Promise<boolean> {
  if (!input.organisationId) return false;
  try {
    await assertActiveWorkspaceAccess({
      userId: input.userId,
      organisationId: input.organisationId,
    });
    return true;
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return false;
    return true;
  }
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
