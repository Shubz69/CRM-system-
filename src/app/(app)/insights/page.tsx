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

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);

  useEffect(() => {
    fetch("/api/insights")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setInsights(j.insights);
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
    </div>
  );
}
