import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
    include: {
      user: { select: { email: true, name: true } },
      organisation: { select: { name: true, slug: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Audit logs</h1>
        <p className="mt-1 text-[var(--muted)]">
          Platform-wide security and change history. Scope distinguishes tenant (ORG) from
          platform-level events.
        </p>
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Scope</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Workspace</th>
              <th className="px-4 py-3">Entity</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-[var(--muted)]" colSpan={6}>
                  No audit entries yet.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="border-b border-[var(--border)]/60">
                  <td className="px-4 py-3 text-[var(--muted)]">{log.createdAt.toISOString()}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        log.scope === "PLATFORM"
                          ? "badge bg-[var(--surface-2)] text-[var(--muted)]"
                          : "badge"
                      }
                    >
                      {log.scope}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{log.action}</td>
                  <td className="px-4 py-3">{log.user?.email || "—"}</td>
                  <td className="px-4 py-3">
                    {log.scope === "PLATFORM"
                      ? "— (platform)"
                      : log.organisation?.name || "—"}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {log.entityType
                      ? `${log.entityType}${log.entityId ? `:${log.entityId.slice(0, 8)}` : ""}`
                      : "—"}
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
