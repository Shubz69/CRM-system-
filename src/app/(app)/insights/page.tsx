"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

type Insight = {
  type: string;
  title: string;
  evidenceCount: number;
  trend: string;
  confidence: number;
  recommendedAction: string;
  items: Array<{ label: string; count: number }>;
};

type Idea = {
  title?: string;
  angle?: string;
  format?: string;
  hook?: string;
  evidenceCount: number;
  confidence: number;
  aiGenerated?: boolean;
  recommendedAction?: string;
};

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [contentIdeas, setContentIdeas] = useState<Idea[]>([]);
  const [adIdeas, setAdIdeas] = useState<Idea[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/insights").then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        return j.insights as Insight[];
      }),
      fetch("/api/insights/content").then(async (r) => {
        const j = await r.json();
        if (!r.ok) return [] as Idea[];
        const raw = (j.suggestions || j.ideas || j.contentIdeas || []) as Array<
          Idea & { type?: string; evidence?: string }
        >;
        return raw.map((item) => ({
          title: item.title,
          format: item.type || item.format,
          hook: item.evidence || item.hook || item.recommendedAction,
          evidenceCount: item.evidenceCount,
          confidence: item.confidence ?? 0.7,
          aiGenerated: item.aiGenerated,
          recommendedAction: item.recommendedAction,
        }));
      }),
      fetch("/api/insights/ads").then(async (r) => {
        const j = await r.json();
        if (!r.ok) return [] as Idea[];
        const raw = (j.suggestions || j.ideas || j.adIdeas || []) as Array<
          Idea & { headline?: string }
        >;
        return raw.map((item) => ({
          title: item.headline || item.title,
          angle: item.angle || item.headline || item.title,
          hook: item.hook || item.angle || item.recommendedAction,
          evidenceCount: item.evidenceCount,
          confidence: item.confidence ?? 0.7,
          aiGenerated: item.aiGenerated !== false,
          recommendedAction: item.recommendedAction,
        }));
      }),
    ])
      .then(([i, c, a]) => {
        setInsights(i);
        setContentIdeas(c);
        setAdIdeas(a);
      })
      .catch((e) => toast.error(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Insights</h1>
        <p className="text-[var(--muted)]">
          Aggregated conversation intelligence with evidence counts and recommended actions.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-secondary"
          type="button"
          onClick={async () => {
            try {
              const res = await fetch("/api/insights/aggregate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "Aggregate failed");
              toast.success("Daily insights aggregated");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Aggregate failed");
            }
          }}
        >
          Run daily aggregation
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {insights.map((insight) => (
          <article key={insight.type} className="surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="h-display text-2xl">{insight.title}</h2>
              <span className="badge">Evidence {insight.evidenceCount}</span>
              <span className="badge">Trend {insight.trend}</span>
              <span className="badge badge-success">
                Confidence {(insight.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--muted)]">{insight.recommendedAction}</p>
            <ul className="mt-4 space-y-2">
              {insight.items.length === 0 && (
                <li className="text-sm text-[var(--muted)]">No evidence yet.</li>
              )}
              {insight.items.slice(0, 6).map((item) => (
                <li key={`${insight.type}-${item.label}`} className="flex justify-between gap-3 text-sm">
                  <span className="line-clamp-2">{item.label}</span>
                  <span className="badge">{item.count}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="h-display text-3xl">Content ideas</h2>
        <p className="text-sm text-[var(--muted)]">AI-generated suggestions grounded in conversation evidence.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {contentIdeas.length === 0 && <div className="surface p-4 text-sm text-[var(--muted)]">No content ideas yet.</div>}
          {contentIdeas.map((idea, idx) => (
            <article key={`c-${idx}`} className="surface p-4">
              <div className="flex flex-wrap gap-2">
                <h3 className="font-semibold">{idea.title || "Content idea"}</h3>
                {idea.aiGenerated !== false && <span className="badge badge-warn">AI suggestion</span>}
                <span className="badge">Evidence {idea.evidenceCount}</span>
              </div>
              <p className="mt-2 text-sm">{idea.hook || idea.recommendedAction}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{idea.format}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="h-display text-3xl">Advertisement ideas</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {adIdeas.length === 0 && <div className="surface p-4 text-sm text-[var(--muted)]">No ad ideas yet.</div>}
          {adIdeas.map((idea, idx) => (
            <article key={`a-${idx}`} className="surface p-4">
              <div className="flex flex-wrap gap-2">
                <h3 className="font-semibold">{idea.angle || idea.title || "Ad angle"}</h3>
                <span className="badge badge-warn">AI suggestion</span>
                <span className="badge">Evidence {idea.evidenceCount}</span>
              </div>
              <p className="mt-2 text-sm">{idea.hook || idea.recommendedAction}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
