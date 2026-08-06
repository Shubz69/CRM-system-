import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const [
    organisations,
    users,
    conversations,
    leads,
    webhookEvents,
    failedJobs,
    auditLogs,
  ] = await Promise.all([
    prisma.organisation.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.conversation.count({ where: { deletedAt: null } }),
    prisma.lead.count({ where: { deletedAt: null } }),
    prisma.webhookEvent.count(),
    prisma.failedJob.count({ where: { resolvedAt: null } }),
    prisma.auditLog.count(),
  ]);

  const cards = [
    { label: "Workspaces", value: organisations, href: "/admin/workspaces" },
    { label: "Users", value: users, href: "/admin/users" },
    { label: "Conversations", value: conversations, href: "/inbox" },
    { label: "Leads", value: leads, href: "/pipeline" },
    { label: "Webhook events", value: webhookEvents, href: "/admin/webhooks" },
    { label: "Open failed jobs", value: failedJobs, href: "/admin/health" },
    { label: "Audit log entries", value: auditLogs, href: "/admin/audit" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Platform overview</h1>
        <p className="mt-1 text-[var(--muted)]">Cross-workspace counts for super administrators.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.label} href={card.href} className="surface block p-5 transition hover:border-[var(--accent)]">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{card.label}</p>
            <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">{card.value}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
