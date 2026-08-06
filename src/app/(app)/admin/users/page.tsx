import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

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
        include: { organisation: { select: { name: true, slug: true } } },
        take: 5,
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Users</h1>
        <p className="mt-1 text-[var(--muted)]">Platform accounts and membership roles.</p>
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3">Memberships</th>
              <th className="px-4 py-3">Last login</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3 font-medium">{user.email}</td>
                <td className="px-4 py-3">{user.name || "—"}</td>
                <td className="px-4 py-3">
                  {!user.isActive
                    ? "Inactive"
                    : user.isSuspended
                      ? "Suspended"
                      : user.lockedUntil && user.lockedUntil > new Date()
                        ? "Locked"
                        : "Active"}
                </td>
                <td className="px-4 py-3">{user.isPlatformAdmin ? "Admin" : "—"}</td>
                <td className="px-4 py-3">
                  {user.memberships.length === 0
                    ? "—"
                    : user.memberships
                        .map((m) => `${m.organisation.name} (${m.role})`)
                        .join(", ")}
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  {user.lastLoginAt ? user.lastLoginAt.toISOString() : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
