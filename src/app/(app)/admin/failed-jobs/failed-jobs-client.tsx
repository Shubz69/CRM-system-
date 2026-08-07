"use client";

import { useState } from "react";
import { toast } from "sonner";

export type FailedJobRow = {
  id: string;
  queue: string;
  jobName: string;
  organisationId: string | null;
  error: string;
  attempts: number;
  createdAt: string;
  resolvedAt: string | null;
};

export function FailedJobsClient({ initial }: { initial: FailedJobRow[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<FailedJobRow | null>(null);

  async function refresh() {
    const res = await fetch("/api/admin/failed-jobs");
    if (!res.ok) return;
    const json = await res.json();
    setRows(
      (json.jobs || []).map((j: FailedJobRow & { status?: string }) => ({
        id: j.id,
        queue: j.queue,
        jobName: j.jobName,
        organisationId: j.organisationId,
        error: j.error,
        attempts: j.attempts,
        createdAt: j.createdAt,
        resolvedAt: j.resolvedAt,
      })),
    );
  }

  async function act(jobId: string, action: "retry" | "cancel") {
    setBusy(`${action}-${jobId}`);
    try {
      const res = await fetch("/api/admin/failed-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, jobId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(action === "retry" ? "Retry recorded (idempotent)" : "Cancelled");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Job type</th>
              <th className="px-3 py-3">Workspace</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Attempts</th>
              <th className="px-3 py-3">Failure</th>
              <th className="px-3 py-3">Created</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((job) => (
              <tr key={job.id} className="border-b border-[var(--border)]/60">
                <td className="px-3 py-3">
                  <div className="font-medium">{job.jobName}</div>
                  <div className="text-xs text-[var(--muted)]">{job.queue}</div>
                </td>
                <td className="px-3 py-3 text-xs">{job.organisationId || "—"}</td>
                <td className="px-3 py-3">{job.resolvedAt ? "Resolved" : "Open"}</td>
                <td className="px-3 py-3">{job.attempts}</td>
                <td className="px-3 py-3 max-w-xs truncate" title={job.error}>
                  {job.error}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {new Date(job.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      className="text-left text-[var(--accent)] hover:underline"
                      onClick={() => setDetail(job)}
                    >
                      View details
                    </button>
                    {!job.resolvedAt && (
                      <>
                        <button
                          type="button"
                          className="text-left text-[var(--accent)] hover:underline"
                          disabled={busy === `retry-${job.id}`}
                          onClick={() => void act(job.id, "retry")}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="text-left text-red-600 hover:underline"
                          disabled={busy === `cancel-${job.id}`}
                          onClick={() => void act(job.id, "cancel")}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-6 text-sm text-[var(--muted)]">No failed jobs. Background processing is clear.</p>
        )}
      </div>

      {detail && (
        <div className="surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="h-display text-xl">Job details</h2>
            <button type="button" className="btn btn-secondary" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
          <pre className="mt-3 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
