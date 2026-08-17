import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { UsersClient, type UserRow } from "./users-client";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      memberships: {
        include: { organisation: { select: { id: true, name: true, slug: true } } },
      },
      sessions: { select: { id: true, expires: true }, take: 10 },
    },
  });

  const initial: UserRow[] = users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.isActive,
    isSuspended: user.isSuspended,
    isPlatformAdmin: user.isPlatformAdmin,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    activeSessions: user.sessions.filter((s) => s.expires > new Date()).length,
    memberships: user.memberships.map((m) => ({
      organisationId: m.organisationId,
      organisationName: m.organisation.name,
      role: m.role,
    })),
  }));

  return (
    <div className="space-y-6">
      <PageHeader description="Search, suspend, reset passwords, and manage roles. Mutations are audited." />
      <UsersClient initial={initial} />
    </div>
  );
}
