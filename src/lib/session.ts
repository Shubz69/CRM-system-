import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertPermission, roleHasPermission, type Permission } from "@/lib/permissions";
import type { MemberRole } from "@prisma/client";
import {
  assertActiveWorkspaceAccess,
  WorkspaceAccessError,
} from "@/services/workspace-access";
import {
  assertExpectedOrganisation,
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
  try {
    await assertActiveWorkspaceAccess({
      userId: session.user.id,
      organisationId: session.user.organisationId,
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      throw new Error("UNAUTHORIZED");
    }
    throw error;
  }
  return {
    userId: session.user.id,
    organisationId: session.user.organisationId,
    role: session.user.role as MemberRole,
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
  assertExpectedOrganisation(session.organisationId, readExpectedOrganisationId(req, body));
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
  assertExpectedOrganisation(session.organisationId, readExpectedOrganisationId(req, body));
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
  return Response.json({ error: message }, { status });
}

export {
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
  readExpectedOrganisationId,
  assertExpectedOrganisation,
};
