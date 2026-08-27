import { redirect } from "next/navigation";
import Link from "next/link";
import { BookingStatus, QualificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    totalWorkspaces,
    activeWorkspaces,
    suspendedWorkspaces,
    totalUsers,
    activeUsers,
    totalContacts,
    totalConversations,
    messagesProcessed,
    aiMessages,
    humanMessages,
    aiExecutions,
    aiHandoffs,
    qualifiedLeads,
    confirmedBookings,
    salesRecorded,
    usageAgg,
    webhookTotal,
    webhookFailed,
    failedJobsOpen,
    failedJobsTotal,
    recentFailures,
    recentWebhooks,
    recentSignIns,
    recentWorkspaces,
    recentBookings,
    recentAiErrors,
  ] = await Promise.all([
    prisma.organisation.count({ where: { deletedAt: null } }),
    prisma.organisation.count({ where: { deletedAt: null, status: "ACTIVE" } }),
    prisma.organisation.count({ where: { deletedAt: null, status: "SUSPENDED" } }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, isActive: true, isSuspended: false } }),
    prisma.contact.count({ where: { deletedAt: null } }),
    prisma.conversation.count({ where: { deletedAt: null } }),
    prisma.message.count(),
    prisma.message.count({ where: { senderType: "AI" } }),
    prisma.message.count({ where: { senderType: "HUMAN" } }),
    prisma.usageRecord.count({ where: { feature: { contains: "ai" } } }),
    prisma.conversation.count({ where: { needsHumanReview: true, deletedAt: null } }),
    prisma.lead.count({
      where: { deletedAt: null, qualificationStatus: QualificationStatus.QUALIFIED },
    }),
    prisma.booking.count({
      where: { status: { in: [BookingStatus.CREATED, BookingStatus.ATTENDED, BookingStatus.RESCHEDULED] } },
    }),
    prisma.lead.count({
      where: { deletedAt: null, stage: { isWon: true } },
    }),
    prisma.usageRecord.aggregate({ _sum: { quantity: true } }),
    prisma.webhookEvent.count(),
    prisma.webhookEvent.count({ where: { status: "FAILED" } }),
    prisma.failedJob.count({ where: { resolvedAt: null } }),
    prisma.failedJob.count(),
    prisma.failedJob.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.webhookEvent.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.user.findMany({
      where: { lastLoginAt: { not: null }, deletedAt: null },
      orderBy: { lastLoginAt: "desc" },
      take: 5,
      select: { email: true, lastLoginAt: true, name: true },
    }),
    prisma.organisation.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { name: true, slug: true, createdAt: true, status: true },
    }),
    prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { contact: { select: { fullName: true } }, organisation: { select: { name: true } } },
    }),
    prisma.auditLog.findMany({
      where: { action: { contains: "ai." } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        action: true,
        scope: true,
        createdAt: true,
        organisationId: true,
      },
    }),
  ]);

  const webhookSuccessRate =
    webhookTotal === 0 ? 100 : Math.round(((webhookTotal - webhookFailed) / webhookTotal) * 1000) / 10;
  const jobSuccessRate =
    failedJobsTotal === 0
      ? 100
      : Math.round(((failedJobsTotal - failedJobsOpen) / Math.max(failedJobsTotal, 1)) * 1000) / 10;
  const platformErrorRate =
    messagesProcessed === 0
      ? 0
      : Math.round((failedJobsOpen / Math.max(messagesProcessed, 1)) * 1000) / 10;
  const estimatedAiCost =
    Math.round(((usageAgg._sum.quantity || 0) * 0.002 + aiMessages * 0.001) * 100) / 100;

  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

  const cards = [
    { label: "Total workspaces", value: totalWorkspaces, href: "/admin/workspaces" },
    { label: "Active workspaces", value: activeWorkspaces, href: "/admin/workspaces" },
    { label: "Suspended workspaces", value: suspendedWorkspaces, href: "/admin/workspaces" },
    { label: "Total users", value: totalUsers, href: "/admin/users" },
    { label: "Active users", value: activeUsers, href: "/admin/users" },
    { label: "Total contacts", value: totalContacts, href: "/admin/workspaces" },
    { label: "Total conversations", value: totalConversations, href: "/admin/workspaces" },
    { label: "Messages processed", value: messagesProcessed, href: "/admin/webhooks" },
    { label: "AI messages sent", value: aiMessages, href: "/admin/usage" },
    { label: "Human messages sent", value: humanMessages, href: "/admin/usage" },
    { label: "AI executions", value: aiExecutions, href: "/admin/usage" },
    { label: "AI handoffs", value: aiHandoffs, href: "/admin/failed-jobs" },
    { label: "Qualified leads", value: qualifiedLeads, href: "/admin/workspaces" },
    { label: "Confirmed bookings", value: confirmedBookings, href: "/admin/workspaces" },
    { label: "Sales recorded", value: salesRecorded, href: "/admin/workspaces" },
    { label: "AI usage (qty)", value: usageAgg._sum.quantity || 0, href: "/admin/usage" },
    { label: "Estimated AI cost", value: `$${estimatedAiCost}`, href: "/admin/usage" },
    { label: "Webhook success rate", value: `${webhookSuccessRate}%`, href: "/admin/webhooks" },
    { label: "Background job success", value: `${jobSuccessRate}%`, href: "/admin/failed-jobs" },
    { label: "Platform error rate", value: `${platformErrorRate}%`, href: "/admin/health" },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        description="Live command centre — metrics from the database, not placeholders."
        actions={
          <div className="surface px-4 py-2 text-sm">
            System status:{" "}
            <span className={dbOk ? "text-[var(--accent)]" : "text-[var(--danger)]"}>
              {dbOk ? "Operational" : "Database error"}
            </span>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="surface block p-4 transition hover:border-[var(--accent)]"
          >
            <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{card.label}</p>
            <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl">{card.value}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentPanel title="Recent failures" href="/admin/failed-jobs">
          {recentFailures.length === 0 ? (
            <Empty>No open failed jobs</Empty>
          ) : (
            recentFailures.map((f) => (
              <li key={f.id} className="border-b border-[var(--border)]/50 py-2 text-sm">
                <div className="font-medium">{f.jobName}</div>
                <div className="text-xs text-[var(--muted)]">{f.error.slice(0, 120)}</div>
              </li>
            ))
          )}
        </RecentPanel>
        <RecentPanel title="Recent webhook activity" href="/admin/webhooks">
          {recentWebhooks.map((w) => (
            <li key={w.id} className="border-b border-[var(--border)]/50 py-2 text-sm">
              <div className="font-medium">
                {w.provider} · {w.eventType}
              </div>
              <div className="text-xs text-[var(--muted)]">
                {w.status} · {w.createdAt.toLocaleString()}
              </div>
            </li>
          ))}
        </RecentPanel>
        <RecentPanel title="Recent sign-ins" href="/admin/users">
          {recentSignIns.map((u) => (
            <li key={u.email} className="border-b border-[var(--border)]/50 py-2 text-sm">
              <div className="font-medium">{u.name || u.email}</div>
              <div className="text-xs text-[var(--muted)]">{u.lastLoginAt?.toLocaleString()}</div>
            </li>
          ))}
        </RecentPanel>
        <RecentPanel title="Recent workspaces" href="/admin/workspaces">
          {recentWorkspaces.map((o) => (
            <li key={o.slug} className="border-b border-[var(--border)]/50 py-2 text-sm">
              <div className="font-medium">{o.name}</div>
              <div className="text-xs text-[var(--muted)]">
                {o.status} · {o.createdAt.toLocaleDateString()}
              </div>
            </li>
          ))}
        </RecentPanel>
        <RecentPanel title="Recent bookings" href="/admin/workspaces">
          {recentBookings.length === 0 ? (
            <Empty>No bookings yet</Empty>
          ) : (
            recentBookings.map((b) => (
              <li key={b.id} className="border-b border-[var(--border)]/50 py-2 text-sm">
                <div className="font-medium">{b.contact.fullName || "Booking"}</div>
                <div className="text-xs text-[var(--muted)]">
                  {b.organisation.name} · {b.status}
                </div>
              </li>
            ))
          )}
        </RecentPanel>
        <RecentPanel title="Recent AI provider errors" href="/admin/health">
          {recentAiErrors.length === 0 ? (
            <Empty>No recent AI errors in audit log</Empty>
          ) : (
            recentAiErrors.map((a) => (
              <li key={a.id} className="border-b border-[var(--border)]/50 py-2 text-sm">
                <div className="font-medium">{a.action}</div>
                <div className="text-xs text-[var(--muted)]">
                  {a.scope} · {a.createdAt.toLocaleString()}
                </div>
              </li>
            ))
          )}
        </RecentPanel>
      </div>
    </div>
  );
}

function RecentPanel({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
        <Link href={href} className="text-xs text-[var(--accent)] hover:underline">
          View all
        </Link>
      </div>
      <ul>{children}</ul>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="py-3 text-sm text-[var(--muted)]">{children}</li>;
}
