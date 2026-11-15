"use client";

import { useSession } from "next-auth/react";
import type { MemberRole } from "@prisma/client";
import { roleHasPermission, type Permission } from "@/lib/permissions";
import { PageLoading } from "@/components/ui/page-state";

/**
 * Renders a page only for roles that hold `permission`. Other roles see a calm explanation
 * instead of a page whose every request answers 403 (a sales agent opening Knowledge, AI Agent
 * or Approvals used to get blank lists and permission errors). The server still enforces the
 * permission on every call; this only stops the page making calls that can't succeed.
 */
export function PermissionGate({
  permission,
  title,
  message,
  children,
}: {
  permission: Permission;
  title: string;
  message: string;
  children: React.ReactNode;
}) {
  const { data, status } = useSession();
  if (status === "loading") return <PageLoading label={`Loading ${title}`} />;
  const role = data?.user?.role as MemberRole | undefined;
  if (role && !roleHasPermission(role, permission)) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="surface p-6" role="note">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--foreground)]">{title}</h2>
          <p className="mt-2 font-medium text-[var(--foreground)]">{message}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Ask a workspace owner or admin if you need access.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
