import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  assertPermission,
  readablePermissionError,
  roleHasPermission,
  type Permission,
} from "@/lib/permissions";
import type { MemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertActiveWorkspaceAccess,
  WorkspaceAccessError,
} from "@/services/workspace-access";
import {
  assertExpectedOrganisation,
  assertExpectedWorkspaceRevision,
  readExpectedWorkspaceRevision,
  readExpectedOrganisationId,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/workspace-mutation-guard";

export async function requireSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.organisationId || !session.user.role) {
    throw new Error("UNAUTHORIZED");
  }
  // Membership must be live — JWT alone is not enough after Team Remove.
  let liveRole: MemberRole;
  try {
    ({ role: liveRole } = await assertActiveWorkspaceAccess({
      userId: session.user.id,
      organisationId: session.user.organisationId,
    }));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      throw new Error("UNAUTHORIZED");
    }
    throw error;
  }
  return {
    userId: session.user.id,
    organisationId: session.user.organisationId,
    // Permissions follow the live membership role, not the role cached in the JWT.
    role: liveRole,
    email: session.user.email,
    name: session.user.name,
    mustChangePassword: Boolean(session.user.mustChangePassword),
    isPlatformAdmin: Boolean(session.user.isPlatformAdmin),
  };
}

/**
 * Session + optional expected-organisation guard for mutating routes.
 * Pass the Request (and parsed body when available) so multi-tab form submits
 * cannot write into a workspace the operator is no longer viewing.
 */
export async function requireSessionForMutation(
  req: Request,
  body?: Record<string, unknown> | null,
) {
  const session = await requireSession();
  const expectedOrgId = readExpectedOrganisationId(req, body);
  const expectedRevision = readExpectedWorkspaceRevision(req, body);
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { activeOrganisationId: true, updatedAt: true },
  });
  const authoritativeOrgId = user?.activeOrganisationId || session.organisationId;
  const authoritativeRevision = user?.updatedAt.toISOString();
  assertExpectedOrganisation(authoritativeOrgId, expectedOrgId);
  if (authoritativeRevision) {
    assertExpectedWorkspaceRevision(authoritativeRevision, expectedRevision);
  }
  return session;
}

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  assertPermission(session.role, permission);
  return session;
}

export async function requirePermissionForMutation(
  permission: Permission,
  req: Request,
  body?: Record<string, unknown> | null,
) {
  const session = await requirePermission(permission);
  const expectedOrgId = readExpectedOrganisationId(req, body);
  const expectedRevision = readExpectedWorkspaceRevision(req, body);
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { activeOrganisationId: true, updatedAt: true },
  });
  const authoritativeOrgId = user?.activeOrganisationId || session.organisationId;
  const authoritativeRevision = user?.updatedAt.toISOString();
  assertExpectedOrganisation(authoritativeOrgId, expectedOrgId);
  if (authoritativeRevision) {
    assertExpectedWorkspaceRevision(authoritativeRevision, expectedRevision);
  }
  return session;
}

export async function requirePlatformAccess() {
  const session = await requireSession();
  // Platform console is for true super admins only — workspace OWNERs stay in workspace UI.
  const allowed =
    session.isPlatformAdmin ||
    session.role === "SUPER_ADMIN" ||
    roleHasPermission(session.role, "platform:manage");
  if (!allowed) {
    throw new Error("Forbidden: missing permission platform:manage");
  }
  return session;
}

export function jsonError(message: string, status = 400) {
  // A permission failure is a 403 even when a route's catch-all would have called it a 400 or
  // 500 (a sales agent opening Automations used to get a 500).
  const httpStatus = message.startsWith("Forbidden") && status >= 400 && status !== 401 ? 403 : status;
  // Routes pass the internal "Forbidden: missing permission x:y" text straight through; never
  // show that to a person.
  const readable = httpStatus === 403 ? readablePermissionError(message) : message;
  return Response.json({ error: readable }, { status: httpStatus });
}

export {
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
  readExpectedOrganisationId,
  readExpectedWorkspaceRevision,
  assertExpectedOrganisation,
  assertExpectedWorkspaceRevision,
};
