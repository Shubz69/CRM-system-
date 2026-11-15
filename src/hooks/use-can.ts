"use client";

import { useSession } from "next-auth/react";
import type { MemberRole } from "@prisma/client";
import { roleHasPermission, type Permission } from "@/lib/permissions";

/**
 * Whether the signed-in member's role has a permission, so pages can hide controls that would
 * only answer 403. While the session is still loading (role unknown) it answers true — the
 * server enforces every permission regardless.
 */
export function useCan(permission: Permission): boolean {
  const { data } = useSession();
  const role = data?.user?.role as MemberRole | undefined;
  if (!role) return true;
  return roleHasPermission(role, permission);
}
