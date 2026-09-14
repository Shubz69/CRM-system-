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
import {
  ResearchFindingCards,
  ResearchSourceCards,
} from "@/components/research/evidence-cards";

type Source = {
  id: string;
  url: string;
  title: string | null;
  platform: string;
  snippet?: string | null;
  author?: string | null;
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

              {(job.status === "FAILED" || job.userFacingError) && (
                <p className="text-sm text-[var(--danger)]">
                  {job.userFacingError || "Research could not finish. Try again from Ask."}
                </p>
              )}

              {job.findings.length > 0 ? (
                <div>
                  {job.status === "PARTIAL" ? (
                    <p className="meta mb-2">
                      Partial result — quotes from collected sources; treat as leads, not verified claims.
                    </p>
                  ) : null}
                  <ResearchFindingCards
                    findings={job.findings.slice(0, 8).map((f) => ({
                      claim: f.claim,
                      sourceUrl: f.source?.url,
                      evidenceExcerpt: f.evidenceExcerpt ?? undefined,
                      sourceTitle: f.source?.title ?? undefined,
                    }))}
                  />
                  {job.findings.some((f) => f.flaggedUnsupported || f.flaggedUngrounded) ? (
                    <p className="meta mt-2">Some findings need review — open the source URL before acting.</p>
                  ) : null}
                </div>
              ) : job.sources.length > 0 ? (
                <p className="text-sm text-[var(--muted)]">
                  Structured findings were incomplete — sources gathered for this job are listed
                  below as leads for verification, not verified claims.
                </p>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  No sources yet — run Research with Ask to gather evidence.
                </p>
              )}

              {job.sources.length > 0 ? (
                <ResearchSourceCards
                  sources={job.sources.map((s) => ({
                    url: s.url,
                    title: s.title ?? undefined,
                    snippet: s.snippet ?? undefined,
                    author: s.author ?? undefined,
                    platform: s.platform,
                  }))}
                />
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
