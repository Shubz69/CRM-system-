"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type ApprovalPayload = {
  actionDescription?: string;
  publishingJobId?: string;
  [key: string]: unknown;
};

type Approval = {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  status: string;
  payload: ApprovalPayload;
  createdAt: string;
  automationRule?: { id: string; name: string; triggerType: string } | null;
};

type PubJob = {
  id: string;
  platform: string;
  status: string;
  externalOutcome: string;
  scheduledAt: string | null;
  piece: { id: string; title: string; status: string };
};

type MissionTask = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  resultSummary: string | null;
};

type Mission = {
  id: string;
  title: string;
  objectiveSummary: string;
  status: string;
  tasks: MissionTask[];
};

function actionDescription(a: Approval): string {
  if (typeof a.payload?.actionDescription === "string" && a.payload.actionDescription) {
    return a.payload.actionDescription;
  }
  return a.summary || a.title;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [publishingJobs, setPublishingJobs] = useState<PubJob[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/approvals");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load approvals");
    setApprovals(json.approvals ?? []);
    setPublishingJobs(json.publishingJobs ?? []);
    setMissions(json.missions ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  async function decide(payload: Record<string, unknown>) {
    const res = await fetch("/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Decision failed");
    return json;
  }

  const pending = approvals.filter((a) => a.status === "PENDING");

  return (
    <div className="space-y-8">
      <PageHeader description="Pending approvals across automations, publishing, and missions — decisions are recorded, publish is never faked." />

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Approval requests</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No pending approval requests.</p>
        ) : (
          pending.map((a) => (
            <div key={a.id} className="surface rounded-lg p-4 space-y-2">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{a.title}</h3>
                <span className="text-xs uppercase">
                  {a.kind} · {a.status}
                </span>
              </div>
              <p className="text-sm">{actionDescription(a)}</p>
              {a.automationRule && (
                <p className="text-xs text-[var(--muted)]">
                  Rule: {a.automationRule.name} ({a.automationRule.triggerType})
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={async () => {
                    try {
                      const result = await decide({
                        id: a.id,
                        decision: "APPROVED",
                      });
                      toast.success(
                        result.message ||
                          (a.kind === "publish"
                            ? "Approved — queued, not externally confirmed"
                            : "Approved"),
                      );
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                >
                  Approve
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={async () => {
                    try {
                      await decide({ id: a.id, decision: "REJECTED" });
                      toast.success("Rejected");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Publishing jobs pending approval</h2>
        {publishingJobs.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No publishing jobs waiting.</p>
        ) : (
          publishingJobs.map((j) => (
            <div key={j.id} className="surface rounded-lg p-4 space-y-2">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{j.piece.title}</h3>
                <span className="text-xs uppercase">{j.status}</span>
              </div>
              <p className="text-sm text-[var(--muted)]">
                {j.platform}
                {j.scheduledAt ? ` · scheduled ${new Date(j.scheduledAt).toLocaleString()}` : ""}
                {" · "}
                outcome {j.externalOutcome}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={async () => {
                    try {
                      const result = await decide({
                        kind: "publishing_job",
                        jobId: j.id,
                        decision: "APPROVED",
                      });
                      toast.success(
                        result.message ||
                          `Moved to ${result.status} — not confirmed until external post id`,
                      );
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                >
                  Approve publish
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={async () => {
                    try {
                      await decide({
                        kind: "publishing_job",
                        jobId: j.id,
                        decision: "REJECTED",
                      });
                      toast.success("Publish cancelled");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Missions waiting approval</h2>
        {missions.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No missions waiting approval.</p>
        ) : (
          missions.map((m) => (
            <div key={m.id} className="surface rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{m.title}</h3>
                <span className="text-xs uppercase">{m.status}</span>
              </div>
              <p className="text-sm text-[var(--muted)]">{m.objectiveSummary}</p>
              {m.tasks.length === 0 ? (
                <p className="text-sm">No tasks waiting for your approval.</p>
              ) : (
                m.tasks.map((t) => (
                  <div key={t.id} className="surface/60 rounded p-3 space-y-2">
                    <p className="text-sm font-medium">{t.title}</p>
                    {t.description && (
                      <p className="text-sm text-[var(--muted)]">{t.description}</p>
                    )}
                    {t.resultSummary && (
                      <p className="text-xs">{t.resultSummary}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={async () => {
                          try {
                            await decide({
                              kind: "mission_task",
                              missionId: m.id,
                              taskId: t.id,
                              decision: "APPROVED",
                            });
                            toast.success("Mission task approved and resumed");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={async () => {
                          try {
                            await decide({
                              kind: "mission_task",
                              missionId: m.id,
                              taskId: t.id,
                              decision: "REJECTED",
                              note: "Rejected from Approvals",
                            });
                            toast.success("Mission task rejected");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
