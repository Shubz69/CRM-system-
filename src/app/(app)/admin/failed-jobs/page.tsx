import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { FailedJobsClient } from "./failed-jobs-client";

export const dynamic = "force-dynamic";

export default async function AdminFailedJobsPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
  }

  const jobs = await prisma.failedJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <PageHeader description="Retry is idempotent — resolved jobs will not create duplicate side effects." />
      <FailedJobsClient
        initial={jobs.map((j) => ({
          id: j.id,
          queue: j.queue,
          jobName: j.jobName,
          organisationId: j.organisationId,
          error: j.error,
          attempts: j.attempts,
          createdAt: j.createdAt.toISOString(),
          resolvedAt: j.resolvedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
