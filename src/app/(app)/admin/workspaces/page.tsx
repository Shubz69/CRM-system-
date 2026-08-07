import { redirect } from "next/navigation";
import { MemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { WorkspacesClient, type WorkspaceRow } from "./workspaces-client";

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
      members: {
        where: { role: { in: [MemberRole.OWNER, MemberRole.SUPER_ADMIN] } },
        include: { user: { select: { id: true, email: true, name: true } } },
        take: 3,
      },
      integrations: { select: { type: true, isActive: true } },
      agentConfigurations: {
        where: { isActive: true },
        select: { id: true },
        take: 1,
      },
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

  const initial: WorkspaceRow[] = orgs.map((org) => {
    const owner = org.members[0]?.user;
    const manychat = org.integrations.find((i) => i.type === "MANYCHAT");
    const booking = org.integrations.find((i) => i.type === "BOOKING");
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      status: org.status,
      autopilotMode: org.autopilotMode,
      demoData: org.demoData,
      owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
      users: org._count.members,
      contacts: org._count.contacts,
      conversations: org._count.conversations,
      aiStatus: org.agentConfigurations[0] ? "Configured" : "Not configured",
      manychatStatus: manychat?.isActive ? "Connected" : "Not connected",
      bookingStatus: booking?.isActive ? "Connected" : "Not connected",
      createdAt: org.createdAt.toISOString(),
      lastActivityAt: org.lastActivityAt?.toISOString() ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Workspaces</h1>
        <p className="mt-1 text-[var(--muted)]">
          Create, suspend, and inspect organisations. Suspension blocks inbound AI processing.
        </p>
      </div>
      <WorkspacesClient initial={initial} />
    </div>
  );
}
