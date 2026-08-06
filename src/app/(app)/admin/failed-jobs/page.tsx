import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminFailedJobsPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const jobs = await prisma.failedJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Failed jobs</h1>
        <p className="mt-1 text-[var(--muted)]">Background work that exhausted retries or failed outbound sends.</p>
      </div>
      <div className="surface overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Queue</th>
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">Error</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-[var(--muted)]">
                  No failed jobs.
                </td>
              </tr>
            )}
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3 font-mono text-xs">{job.queue}</td>
                <td className="px-4 py-3">{job.jobName}</td>
                <td className="max-w-md truncate px-4 py-3 text-[var(--danger)]">{job.error}</td>
                <td className="px-4 py-3">{job.attempts}</td>
                <td className="px-4 py-3 text-xs text-[var(--muted)]">
                  {job.createdAt.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
