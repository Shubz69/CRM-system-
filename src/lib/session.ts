import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertPermission, roleHasPermission, type Permission } from "@/lib/permissions";
import type { MemberRole } from "@prisma/client";

export async function requireSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.organisationId || !session.user.role) {
    throw new Error("UNAUTHORIZED");
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

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  assertPermission(session.role, permission);
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
