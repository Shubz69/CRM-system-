"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";
import { statusLabel } from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type Source = {
  id: string;
  url: string;
  title: string | null;
  platform: string;
  freshnessScore: number | null;
  publishedAt: string | null;
  retrievedAt: string;
};

type Finding = {
  id: string;
  claim: string;
  evidenceExcerpt: string | null;
  confidence: number | null;
  claimKind: string;
  freshnessScore: number | null;
  verifiedByCritic: boolean;
  flaggedUnsupported: boolean;
  flaggedUngrounded: boolean;
  source: Source;
};

type Quality = {
  id: string;
  gateStatus: string;
  criticNotes: string | null;
  escalationReason: string | null;
  assessedAt: string;
} | null;

type ResearchJob = {
  id: string;
  kind: string;
  topic: string;
  status: string;
  error: string | null;
  userFacingError: string | null;
  agentRunId: string | null;
  createdAt: string;
  finishedAt: string | null;
  findings: Finding[];
  sources: Source[];
  qualityAssessment: Quality;
  criticReport: unknown;
  gaps: unknown;
  contradictions: unknown;
};

export default function ResearchPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const router = useRouter();
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [topic, setTopic] = useState("");
  const [answerMode, setAnswerMode] = useState<"" | "QUICK" | "EXECUTIVE" | "ACTION" | "DEEP">("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/research");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load research");
    setJobs(json.jobs ?? []);
  }, []);

  useEffect(() => {
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  return (
    <PageShell>
      <PageHeader description="Market and competitor briefs with sources — Agent Desk never invents findings." />

      <section className="surface space-y-3 p-5">
        <h2 className="section-title">Start research</h2>
        <p className="text-sm text-[var(--muted)]">
          Save a topic to track, or run a full research request through Ask for sourced findings.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="input min-w-[240px] flex-1"
            placeholder="e.g. Competitors offering AI booking for clinics"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="Research topic"
          />
          <select
            className="input w-auto"
            value={answerMode}
            onChange={(e) =>
              setAnswerMode(e.target.value as "" | "QUICK" | "EXECUTIVE" | "ACTION" | "DEEP")
            }
            aria-label="Answer format"
          >
            <option value="">Ask me how to answer</option>
            <option value="QUICK">Quick Answer</option>
            <option value="EXECUTIVE">Executive Brief</option>
            <option value="ACTION">Action Plan</option>
            <option value="DEEP">Deep Report</option>
          </select>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy || !topic.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await fetch("/api/research", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "create_draft", topic }),
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Could not save topic");
                toast.success("Topic saved — findings appear after you run research");
                setTopic("");
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Save topic
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              const trimmed = topic.trim();
              if (!trimmed) {
                toast.message("Enter a research topic first");
                return;
              }
              setBusy(true);
              try {
                const res = await workspaceFetch(
                  workspaceContext.loadedOrganisationId,
                  workspaceContext.workspaceRevision,
                  "/api/ask",
                  {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    request: `Research ${trimmed}`,
                    ...(answerMode ? { answerMode } : {}),
                  }),
                  },
                );
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Ask failed");
                toast.success(
                  answerMode
                    ? "Research started — results will appear when ready"
                    : "Research started — you'll be asked how to format the answer",
                );
                setTopic("");
                await load();
                if (json.runId) {
                  router.push(`/ask?runId=${encodeURIComponent(json.runId)}`);
                }
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Research with Ask
          </button>
        </div>
        <p className="text-xs text-[var(--muted)]">
          Prefer guided prompts?{" "}
          <Link href="/ask" className="underline underline-offset-2">
            Open Ask
          </Link>
        </p>
      </section>

      {loading ? (
        <PageLoading label="Loading research" />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No research yet"
          body="Start with a market or competitor topic. Findings only appear when sources are retrieved."
          actions={[
            { href: "/ask", label: "Ask to research", primary: true },
            { href: "/opportunities", label: "View opportunities" },
          ]}
        />
      ) : (
        <div className="space-y-4">
          <h2 className="section-title">Recent research</h2>
          {jobs.map((job) => (
            <article key={job.id} className="surface space-y-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="caption">{statusLabel(job.status)}</p>
                  <h3 className="section-title mt-1">{job.topic}</h3>
                </div>
                <span className="meta">{new Date(job.createdAt).toLocaleString()}</span>
              </div>

              {(job.error || job.userFacingError) && (
                <p className="text-sm text-[var(--danger)]">
                  {job.userFacingError || "Research could not finish. Try again from Ask."}
                </p>
              )}

              {job.findings.length > 0 ? (
                <div>
                  <h4 className="card-title">Key findings</h4>
                  <ul className="mt-2 space-y-2 text-sm">
                    {job.findings.slice(0, 8).map((f) => (
                      <li key={f.id} className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                        <p className="text-[var(--foreground)]">{f.claim}</p>
                        {f.evidenceExcerpt ? (
                          <p className="meta mt-1 leading-relaxed">{f.evidenceExcerpt}</p>
                        ) : null}
                        {f.flaggedUnsupported || f.flaggedUngrounded ? (
                          <span className="badge badge-warn mt-2">Needs review</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  No findings yet — run Research with Ask to populate sources.
                </p>
              )}

              {job.sources.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    Sources ({job.sources.length})
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                    {job.sources.map((s) => (
                      <li key={s.id}>
                        <a
                          className="underline underline-offset-2"
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {job.qualityAssessment ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-[var(--muted)]">
                    Quality notes
                  </summary>
                  <p className="meta mt-2 leading-relaxed">
                    {job.qualityAssessment.criticNotes ||
                      statusLabel(job.qualityAssessment.gateStatus)}
                    {job.qualityAssessment.escalationReason
                      ? ` · ${job.qualityAssessment.escalationReason}`
                      : ""}
                  </p>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
