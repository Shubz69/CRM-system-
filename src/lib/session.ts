import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertPermission, type Permission } from "@/lib/permissions";
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
  };
}

export async function requirePermission(permission: Permission) {
  const session = await requireSession();
  assertPermission(session.role, permission);
  return session;
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
