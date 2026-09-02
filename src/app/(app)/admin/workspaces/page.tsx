import { redirect } from "next/navigation";
import { MemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { WorkspacesClient, type WorkspaceRow } from "./workspaces-client";
import { getBetaWorkspaceMeta, countConnectedSocialAccounts } from "@/services/beta-workspace";
import { getSocialConnectionPolicy } from "@/services/social-connection-policy";

export const dynamic = "force-dynamic";

export default async function AdminWorkspacesPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
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
      invitations: {
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      },
      aiBudget: true,
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

  const initial: WorkspaceRow[] = await Promise.all(
    orgs.map(async (org) => {
      const owner = org.members[0]?.user;
      const beta = await getBetaWorkspaceMeta(org.id);
      const socialPolicy = await getSocialConnectionPolicy(org.id);
      const connectedSocialCount = await countConnectedSocialAccounts(org.id);
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
        aiStatus: "—",
        manychatStatus: "—",
        bookingStatus: "—",
        createdAt: org.createdAt.toISOString(),
        lastActivityAt: org.lastActivityAt?.toISOString() ?? null,
        betaStatus: beta?.status ?? (org.plan === "beta" ? "BETA_ACTIVE" : null),
        betaLabel: beta?.label ?? null,
        connectedSocialCount,
        socialLimit: socialPolicy.maxConnectedSocialAccounts,
        pendingInvites: org.invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          expiresAt: i.expiresAt.toISOString(),
        })),
        aiBudgetMonthlyCapCents: org.aiBudget?.monthlyCapCents ?? null,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader description="Create beta organisations, invite testers, set social limits and AI budgets. Suspension preserves data and connected accounts." />
      <WorkspacesClient initial={initial} />
    </div>
  );
}
