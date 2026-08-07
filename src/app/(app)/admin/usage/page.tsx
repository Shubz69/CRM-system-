import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

function estimateCost(feature: string, quantity: number, provider: string | null) {
  const p = (provider || "").toLowerCase();
  let perUnit = 0.001;
  if (p.includes("openai") || feature.includes("openai")) perUnit = 0.002;
  if (p.includes("anthropic") || feature.includes("anthropic")) perUnit = 0.003;
  if (feature.includes("token")) perUnit = 0.00002;
  return Math.round(quantity * perUnit * 100) / 100;
}

export default async function AdminUsagePage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);

  const [records, byOrg, recent, aiMessages, failedAi] = await Promise.all([
    prisma.usageRecord.groupBy({
      by: ["feature", "provider"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true },
      _count: true,
      _avg: { quantity: true },
    }),
    prisma.usageRecord.groupBy({
      by: ["organisationId", "provider"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true },
      _count: true,
    }),
    prisma.usageRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.message.count({
      where: { senderType: "AI", createdAt: { gte: since } },
    }),
    prisma.auditLog.count({
      where: { action: { contains: "ai." }, createdAt: { gte: since } },
    }),
  ]);

  records.sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0));

  const orgIds = byOrg.map((r) => r.organisationId).filter(Boolean) as string[];
  const orgs = await prisma.organisation.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true },
  });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const totalQty = records.reduce((sum, r) => sum + (r._sum.quantity ?? 0), 0);
  const totalCost = records.reduce(
    (sum, r) => sum + estimateCost(r.feature, r._sum.quantity ?? 0, r.provider),
    0,
  );
  const failureRate =
    aiMessages + failedAi === 0 ? 0 : Math.round((failedAi / Math.max(aiMessages + failedAi, 1)) * 1000) / 10;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">AI Usage</h1>
        <p className="mt-1 text-[var(--muted)]">
          Real UsageRecord aggregates for the last 30 days. Estimated cost is indicative only.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="surface p-4">
          <p className="text-xs uppercase text-[var(--muted)]">Requests</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">{totalQty}</p>
        </div>
        <div className="surface p-4">
          <p className="text-xs uppercase text-[var(--muted)]">AI messages</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">{aiMessages}</p>
        </div>
        <div className="surface p-4">
          <p className="text-xs uppercase text-[var(--muted)]">Estimated cost</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">${totalCost}</p>
        </div>
        <div className="surface p-4">
          <p className="text-xs uppercase text-[var(--muted)]">Failure rate</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">{failureRate}%</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {records.map((row) => (
          <div key={`${row.feature}-${row.provider}`} className="surface p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{row.feature}</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Provider: {row.provider || "n/a"}</p>
            <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">
              {row._sum.quantity ?? 0}
            </p>
            <p className="text-xs text-[var(--muted)]">
              {row._count} events · est. ${estimateCost(row.feature, row._sum.quantity ?? 0, row.provider)}
            </p>
          </div>
        ))}
        {records.length === 0 && (
          <div className="surface p-6 text-[var(--muted)]">No usage recorded yet.</div>
        )}
      </div>

      <div className="surface overflow-x-auto">
        <h2 className="px-4 pt-4 h-display text-2xl">By workspace</h2>
        <table className="mt-2 w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Workspace</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Requests</th>
              <th className="px-4 py-3">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {byOrg.map((row) => (
              <tr key={`${row.organisationId}-${row.provider}`} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3">
                  {row.organisationId ? orgName.get(row.organisationId) || row.organisationId : "Platform"}
                </td>
                <td className="px-4 py-3">{row.provider || "—"}</td>
                <td className="px-4 py-3">{row._sum.quantity ?? 0}</td>
                <td className="px-4 py-3">
                  ${estimateCost("ai", row._sum.quantity ?? 0, row.provider)}
                </td>
              </tr>
            ))}
            {byOrg.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-[var(--muted)]" colSpan={4}>
                  No workspace usage yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Feature</th>
              <th className="px-4 py-3">Provider / model</th>
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
                <td className="px-4 py-3 text-xs text-[var(--muted)]">
                  {r.createdAt.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
