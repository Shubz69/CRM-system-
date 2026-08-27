"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";
import { statusLabel, trendStageLabel } from "@/lib/customer-labels";

type Cluster = {
  id: string;
  key: string;
  label: string;
  kind: string;
  state: string;
  platforms: string[];
  evidenceUrls: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  features: unknown;
};

type Snapshot = {
  id: string;
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  score: number | null;
  socialContent: {
    id: string;
    platform: string;
    url: string;
    title: string | null;
  } | null;
};

type CollectionRun = {
  id: string;
  kind: string;
  providerKey: string | null;
  status: string;
  observedAt: string;
  itemsCollected: number;
  errorSummary: string | null;
};

function freshnessLabel(lastSeenAt: string): string {
  const ms = Date.now() - new Date(lastSeenAt).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.max(0, Math.round(hours))}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function SocialIntelligencePage() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [runs, setRuns] = useState<CollectionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/social-intelligence");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load social trends");
    setClusters(json.clusters ?? []);
    setSnapshots(json.metricSnapshots ?? []);
    setRuns(json.collectionRuns ?? []);
  }, []);

  useEffect(() => {
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  const empty = clusters.length === 0 && snapshots.length === 0 && runs.length === 0;

  return (
    <PageShell>
      <PageHeader description="Trends and audience signals from connected listening — only when evidence exists." />

      {loading ? (
        <PageLoading label="Loading social trends" />
      ) : empty ? (
        <EmptyState
          title="No social trends yet"
          body="Connect social listening or run research so Agent Desk can surface emerging topics with evidence."
          actions={[
            { href: "/integrations", label: "Open Integrations", primary: true },
            { href: "/research", label: "Start research" },
            { href: "/content", label: "Content workspace" },
          ]}
        />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="section-title">Trends</h2>
            {clusters.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No trend clusters yet.</p>
            ) : (
              clusters.map((c) => (
                <article key={c.id} className="surface space-y-2 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="card-title">{c.label}</h3>
                    <span className="badge badge-success">{trendStageLabel(c.state)}</span>
                  </div>
                  <p className="meta">
                    {c.platforms.length ? c.platforms.join(", ") : "Multi-platform"}
                    {" · "}
                    Freshness {freshnessLabel(c.lastSeenAt)}
                  </p>
                  {c.evidenceUrls.length > 0 ? (
                    <ul className="list-disc pl-5 text-xs text-[var(--muted)]">
                      {c.evidenceUrls.slice(0, 4).map((u) => (
                        <li key={u}>
                          <a className="underline" href={u} target="_blank" rel="noreferrer">
                            {u}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="section-title">Recent posts tracked</h2>
            {snapshots.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No post metrics yet.</p>
            ) : (
              <ul className="space-y-2">
                {snapshots.map((s) => (
                  <li key={s.id} className="surface p-4 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium">
                        {s.socialContent?.title || s.socialContent?.url || "Post"}
                      </span>
                      <span className="meta">{new Date(s.capturedAt).toLocaleString()}</span>
                    </div>
                    <p className="meta mt-1">
                      {s.socialContent?.platform ?? "—"}
                      {s.views != null ? ` · ${s.views.toLocaleString()} views` : ""}
                      {s.likes != null ? ` · ${s.likes.toLocaleString()} likes` : ""}
                      {s.comments != null ? ` · ${s.comments.toLocaleString()} comments` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div>
            <button
              type="button"
              className="text-sm text-[var(--muted)] underline underline-offset-2"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "Hide collection history" : "Show collection history"}
            </button>
            {showAdvanced && (
              <ul className="mt-3 space-y-2">
                {runs.length === 0 ? (
                  <li className="text-sm text-[var(--muted)]">No collection history yet.</li>
                ) : (
                  runs.map((r) => (
                    <li key={r.id} className="surface p-3 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span>{r.kind}{r.providerKey ? ` · ${r.providerKey}` : ""}</span>
                        <span className="badge">{statusLabel(r.status)}</span>
                      </div>
                      <p className="meta mt-1">
                        {new Date(r.observedAt).toLocaleString()} · {r.itemsCollected} items
                      </p>
                      {r.errorSummary ? (
                        <p className="mt-1 text-xs text-[var(--danger)]">{r.errorSummary}</p>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </PageShell>
  );
}
