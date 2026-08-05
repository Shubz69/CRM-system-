import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  const orgId = session?.user.organisationId;

  const [org, members, integrations, auditLogs] = orgId
    ? await Promise.all([
        prisma.organisation.findUnique({ where: { id: orgId } }),
        prisma.organisationMember.findMany({
          where: { organisationId: orgId },
          include: { user: { select: { email: true, name: true } } },
        }),
        prisma.integration.findMany({ where: { organisationId: orgId } }),
        prisma.auditLog.findMany({
          where: { organisationId: orgId },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      ])
    : [null, [], [], []];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Settings & integrations</h1>
        <p className="text-[var(--muted)]">Organisation, team, integrations, and audit trail.</p>
      </div>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Organisation</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Name</dt>
            <dd className="font-medium">{org?.name}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Slug</dt>
            <dd className="font-medium">{org?.slug}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Timezone</dt>
            <dd className="font-medium">{org?.timezone}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Data retention (days)</dt>
            <dd className="font-medium">{org?.dataRetentionDays}</dd>
          </div>
        </dl>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Team members</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {members.map((m) => (
            <li key={m.id} className="flex justify-between gap-3 border-b border-[var(--border)] py-2">
              <span>
                {m.user.name || m.user.email}
                <span className="block text-xs text-[var(--muted)]">{m.user.email}</span>
              </span>
              <span className="badge">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Integrations</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            ["ManyChat / Instagram", "Use mock transport locally. Set MANYCHAT_* env vars for live."],
            ["AI providers", "Configure mock, OpenAI, or Anthropic in AI Agent settings."],
            ["Booking", "DEFAULT_BOOKING_URL + booking webhook at /api/webhooks/booking"],
            ["Google Sheets", "Adapter placeholder — export hooks ready in Reports."],
            ["Redis / BullMQ", "Required for production workers. Optional locally with in-process fallback."],
          ].map(([title, body]) => (
            <div key={title} className="rounded-xl border border-[var(--border)] p-4">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">{body}</p>
            </div>
          ))}
          {integrations.map((i) => (
            <div key={i.id} className="rounded-xl border border-[var(--border)] p-4">
              <h3 className="font-semibold">
                {i.name} ({i.type})
              </h3>
              <p className="text-sm text-[var(--muted)]">{i.isActive ? "Active" : "Inactive"}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Audit log</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {auditLogs.length === 0 && <li className="text-[var(--muted)]">No audit events yet.</li>}
          {auditLogs.map((log) => (
            <li key={log.id} className="border-b border-[var(--border)] py-2">
              <span className="font-medium">{log.action}</span>
              <span className="text-[var(--muted)]">
                {" "}
                · {log.entityType} {log.entityId?.slice(0, 8)} ·{" "}
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
