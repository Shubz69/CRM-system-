import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminWebhooksPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const events = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      organisation: { select: { name: true, slug: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Webhook events</h1>
        <p className="mt-1 text-[var(--muted)]">Recent inbound webhook processing across workspaces.</p>
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Workspace</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Error</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-[var(--muted)]" colSpan={6}>
                  No webhook events yet.
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.id} className="border-b border-[var(--border)]/60">
                  <td className="px-4 py-3">{event.provider}</td>
                  <td className="px-4 py-3">{event.eventType}</td>
                  <td className="px-4 py-3">{event.status}</td>
                  <td className="px-4 py-3">
                    {event.organisation?.name || "—"}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{event.createdAt.toISOString()}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-[var(--danger)]">
                    {event.error || "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
