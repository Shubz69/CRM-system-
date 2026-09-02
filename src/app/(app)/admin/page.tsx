import { redirect } from "next/navigation";
import Link from "next/link";
import { BookingStatus, QualificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

/**
 * Platform admin overview — keep Prisma concurrency bounded.
 * Production pool is typically connection_limit=5; a 26-way Promise.all exhausts it.
 */
async function loadAdminOverviewMetrics() {
  type KpiRow = {
    total_workspaces: bigint;
    active_workspaces: bigint;
    suspended_workspaces: bigint;
    total_users: bigint;
    active_users: bigint;
    total_contacts: bigint;
    total_conversations: bigint;
    messages_processed: bigint;
    ai_messages: bigint;
    human_messages: bigint;
    ai_executions: bigint;
    ai_handoffs: bigint;
    qualified_leads: bigint;
    confirmed_bookings: bigint;
    sales_recorded: bigint;
    usage_qty: bigint | null;
    webhook_total: bigint;
    webhook_failed: bigint;
    failed_jobs_open: bigint;
    failed_jobs_total: bigint;
  };

  const [kpi] = await prisma.$queryRaw<KpiRow[]>`
    SELECT
      (SELECT COUNT(*)::bigint FROM "Organisation" WHERE "deletedAt" IS NULL) AS total_workspaces,
      (SELECT COUNT(*)::bigint FROM "Organisation" WHERE "deletedAt" IS NULL AND status = 'ACTIVE') AS active_workspaces,
      (SELECT COUNT(*)::bigint FROM "Organisation" WHERE "deletedAt" IS NULL AND status = 'SUSPENDED') AS suspended_workspaces,
      (SELECT COUNT(*)::bigint FROM "User" WHERE "deletedAt" IS NULL) AS total_users,
      (SELECT COUNT(*)::bigint FROM "User" WHERE "deletedAt" IS NULL AND "isActive" = true AND "isSuspended" = false) AS active_users,
      (SELECT COUNT(*)::bigint FROM "Contact" WHERE "deletedAt" IS NULL) AS total_contacts,
      (SELECT COUNT(*)::bigint FROM "Conversation" WHERE "deletedAt" IS NULL) AS total_conversations,
      (SELECT COUNT(*)::bigint FROM "Message") AS messages_processed,
      (SELECT COUNT(*)::bigint FROM "Message" WHERE "senderType" = 'AI') AS ai_messages,
      (SELECT COUNT(*)::bigint FROM "Message" WHERE "senderType" = 'HUMAN') AS human_messages,
      (SELECT COUNT(*)::bigint FROM "UsageRecord" WHERE feature ILIKE '%ai%') AS ai_executions,
      (SELECT COUNT(*)::bigint FROM "Conversation" WHERE "needsHumanReview" = true AND "deletedAt" IS NULL) AS ai_handoffs,
      (SELECT COUNT(*)::bigint FROM "Lead" WHERE "deletedAt" IS NULL AND "qualificationStatus" = ${QualificationStatus.QUALIFIED}::"QualificationStatus") AS qualified_leads,
      (SELECT COUNT(*)::bigint FROM "Booking" WHERE status IN (
        ${BookingStatus.CREATED}::"BookingStatus",
        ${BookingStatus.ATTENDED}::"BookingStatus",
        ${BookingStatus.RESCHEDULED}::"BookingStatus"
      )) AS confirmed_bookings,
      (SELECT COUNT(*)::bigint FROM "Lead" l INNER JOIN "PipelineStage" s ON s.id = l."stageId" WHERE l."deletedAt" IS NULL AND s."isWon" = true) AS sales_recorded,
      (SELECT COALESCE(SUM(quantity), 0)::bigint FROM "UsageRecord") AS usage_qty,
      (SELECT COUNT(*)::bigint FROM "WebhookEvent") AS webhook_total,
      (SELECT COUNT(*)::bigint FROM "WebhookEvent" WHERE status = 'FAILED') AS webhook_failed,
      (SELECT COUNT(*)::bigint FROM "FailedJob" WHERE "resolvedAt" IS NULL) AS failed_jobs_open,
      (SELECT COUNT(*)::bigint FROM "FailedJob") AS failed_jobs_total
  `;

  const [
    recentFailures,
    recentWebhooks,
    recentSignIns,
    recentWorkspaces,
    recentBookings,
    recentAiErrors,
    dbOk,
  ] = await Promise.all([
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
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ]);

  const n = (v: bigint | null | undefined) => Number(v ?? 0);

  return {
    totalWorkspaces: n(kpi?.total_workspaces),
    activeWorkspaces: n(kpi?.active_workspaces),
    suspendedWorkspaces: n(kpi?.suspended_workspaces),
    totalUsers: n(kpi?.total_users),
    activeUsers: n(kpi?.active_users),
    totalContacts: n(kpi?.total_contacts),
    totalConversations: n(kpi?.total_conversations),
    messagesProcessed: n(kpi?.messages_processed),
    aiMessages: n(kpi?.ai_messages),
    humanMessages: n(kpi?.human_messages),
    aiExecutions: n(kpi?.ai_executions),
    aiHandoffs: n(kpi?.ai_handoffs),
    qualifiedLeads: n(kpi?.qualified_leads),
    confirmedBookings: n(kpi?.confirmed_bookings),
    salesRecorded: n(kpi?.sales_recorded),
    usageQty: n(kpi?.usage_qty),
    webhookTotal: n(kpi?.webhook_total),
    webhookFailed: n(kpi?.webhook_failed),
    failedJobsOpen: n(kpi?.failed_jobs_open),
    failedJobsTotal: n(kpi?.failed_jobs_total),
    recentFailures,
    recentWebhooks,
    recentSignIns,
    recentWorkspaces,
    recentBookings,
    recentAiErrors,
    dbOk,
  };
}

export default async function AdminOverviewPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
  }

  const {
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
    usageQty,
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
    dbOk,
  } = await loadAdminOverviewMetrics();

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
    Math.round((usageQty * 0.002 + aiMessages * 0.001) * 100) / 100;

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
    { label: "AI usage (qty)", value: usageQty, href: "/admin/usage" },
    { label: "Estimated AI cost", value: `$${estimatedAiCost}`, href: "/admin/usage" },
    { label: "Webhook success rate", value: `${webhookSuccessRate}%`, href: "/admin/webhooks" },
    { label: "Background job success", value: `${jobSuccessRate}%`, href: "/admin/failed-jobs" },
    { label: "Platform error rate", value: `${platformErrorRate}%`, href: "/admin/health" },
  ];

  const groups: Array<{ title: string; keys: string[] }> = [
    {
      title: "Platform",
      keys: ["Total workspaces", "Active workspaces", "Suspended workspaces", "Total users", "Active users"],
    },
    {
      title: "Messaging",
      keys: ["Total conversations", "Messages processed", "AI handoffs", "Human messages sent"],
    },
    {
      title: "AI",
      keys: ["AI messages sent", "AI executions", "AI usage (qty)", "Estimated AI cost"],
    },
    {
      title: "Sales",
      keys: ["Total contacts", "Qualified leads", "Confirmed bookings", "Sales recorded"],
    },
    {
      title: "Reliability",
      keys: ["Webhook success rate", "Background job success", "Platform error rate"],
    },
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

      <div className="space-y-6">
        {groups.map((group) => {
          const groupCards = cards.filter((c) => group.keys.includes(c.label));
          return (
            <section key={group.title} className="space-y-3">
              <h2 className="caption">{group.title}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {groupCards.map((card) => (
                  <Link
                    key={card.label}
                    href={card.href}
                    className="surface block p-4 transition hover:border-[var(--accent)]"
                  >
                    <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {card.label}
                    </p>
                    <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl">
                      {card.value}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
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
