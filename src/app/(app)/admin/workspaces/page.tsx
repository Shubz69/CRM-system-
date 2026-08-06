import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminWorkspacesPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const orgs = await prisma.organisation.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      _count: {
        select: {
          members: true,
          contacts: true,
          conversations: true,
          leads: true,
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Workspaces</h1>
        <p className="mt-1 text-[var(--muted)]">Organisations on this platform.</p>
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Contacts</th>
              <th className="px-4 py-3">Conversations</th>
              <th className="px-4 py-3">Leads</th>
              <th className="px-4 py-3">Flags</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3 font-medium">{org.name}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{org.slug}</td>
                <td className="px-4 py-3">{org._count.members}</td>
                <td className="px-4 py-3">{org._count.contacts}</td>
                <td className="px-4 py-3">{org._count.conversations}</td>
                <td className="px-4 py-3">{org._count.leads}</td>
                <td className="px-4 py-3">
                  {org.demoData ? <span className="badge badge-warn">Demo</span> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
