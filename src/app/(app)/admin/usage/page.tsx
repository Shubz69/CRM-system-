import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminUsagePage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  const records = await prisma.usageRecord.groupBy({
    by: ["feature", "provider"],
    where: { createdAt: { gte: since } },
    _sum: { quantity: true },
    _count: true,
  });
  records.sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0));

  const recent = await prisma.usageRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">AI & platform usage</h1>
        <p className="mt-1 text-[var(--muted)]">Aggregated usage for the last 30 days. Provider keys are never shown.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {records.map((row) => (
          <div key={`${row.feature}-${row.provider}`} className="surface p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{row.feature}</p>
            <p className="mt-1 text-sm text-[var(--muted)]">{row.provider || "n/a"}</p>
            <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">
              {row._sum.quantity ?? 0}
            </p>
            <p className="text-xs text-[var(--muted)]">{row._count} events</p>
          </div>
        ))}
        {records.length === 0 && (
          <div className="surface p-6 text-[var(--muted)]">No usage recorded yet.</div>
        )}
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Feature</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3">{r.feature}</td>
                <td className="px-4 py-3">{r.provider || "—"}</td>
                <td className="px-4 py-3">{r.quantity}</td>
                <td className="px-4 py-3 text-xs text-[var(--muted)]">{r.createdAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
