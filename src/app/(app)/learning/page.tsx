"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

type CreativePattern = {
  id: string;
  label: string;
  sampleSize: number;
  maturity: string;
  maturityLabel: string;
  showAsRecommendation: boolean;
};

type FeedbackSummary = { total: number; bySignal: Record<string, number> };

type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  status: string;
  resultSummary: {
    sampleSize?: number;
    winnerKey?: string | null;
    message?: string;
  } | null;
};

const MATURITY_COPY: Record<string, string> = {
  INSUFFICIENT_DATA: "Not enough data",
  EARLY: "Early signal",
  SUPPORTED: "Supported pattern",
  STRONG: "Strong pattern",
};

function maturityLabel(maturity: string, fallback: string) {
  return MATURITY_COPY[maturity] ?? fallback;
}

/**
 * Customer Analytics → Learning: business insights only.
 * Engineering eval / candidates / calibration live under Admin → Learning Lab.
 */
export default function LearningPage() {
  const [feedback, setFeedback] = useState<FeedbackSummary>({ total: 0, bySignal: {} });
  const [patterns, setPatterns] = useState<CreativePattern[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/learning");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load learning");
    setFeedback(json.feedback ?? { total: 0, bySignal: {} });
    setPatterns(json.creativePatterns ?? []);
    setExperiments(json.experiments ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  const changing = useMemo(
    () => patterns.filter((p) => p.maturity === "EARLY" || p.maturity === "SUPPORTED"),
    [patterns],
  );
  const working = useMemo(
    () => patterns.filter((p) => p.showAsRecommendation || p.maturity === "STRONG"),
    [patterns],
  );
  const needsData = useMemo(
    () => patterns.filter((p) => p.maturity === "INSUFFICIENT_DATA"),
    [patterns],
  );
  const corrections = useMemo(() => {
    const signals = Object.entries(feedback.bySignal);
    return signals.map(([signal, count]) => ({
      signal,
      count,
      copy:
        signal === "APPROVE" || signal === "THUMBS_UP"
          ? "You approved recommendations — Agent Desk keeps those approaches in mind."
          : signal === "DISMISS" || signal === "THUMBS_DOWN"
            ? "You dismissed recommendations — those paths are deprioritised."
            : `${signal.replace(/_/g, " ").toLowerCase()} · ${count}`,
    }));
  }, [feedback]);

  const completedExperiments = experiments.filter(
    (ex) => ex.status === "COMPLETED" || ex.resultSummary?.message,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader description="What is changing in your market and messaging — only patterns with enough evidence." />

      {loading ? (
        <div className="surface-muted p-6 text-sm text-[var(--muted)]">Loading learning…</div>
      ) : null}

      <section className="space-y-3">
        <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
          What is changing
        </h2>
        {changing.length === 0 ? (
          <div className="surface-insight p-5">
            <p className="font-medium">No early shifts yet</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              As conversations and content accumulate, Agent Desk will surface emerging themes here —
              for example price objections becoming more common, or reply speed correlating with
              progress.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {changing.map((p) => (
              <li key={p.id} className="surface-insight flex flex-wrap items-start gap-3 p-4">
                <span className="badge badge-warn">{maturityLabel(p.maturity, p.maturityLabel)}</span>
                <p className="min-w-0 flex-1 text-sm font-medium leading-relaxed">{p.label}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
          What seems to work
        </h2>
        {working.length === 0 ? (
          <div className="surface p-5">
            <p className="font-medium">Not enough supported patterns yet</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Qualified leads that receive a reply within a few hours often progress more often —
              Agent Desk will confirm patterns like this once sample size is reliable.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {working.map((p) => (
              <li key={p.id} className="surface-primary flex flex-wrap items-start gap-3 p-4">
                <span className="badge badge-success">
                  {maturityLabel(p.maturity, p.maturityLabel)}
                </span>
                <p className="min-w-0 flex-1 text-sm font-medium leading-relaxed">{p.label}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
          What needs more data
        </h2>
        {needsData.length === 0 && patterns.length === 0 ? (
          <div className="surface-muted p-5">
            <p className="font-medium">Not enough content or conversations yet</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Publish more content or keep messaging active so Agent Desk can identify reliable
              patterns.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/content" className="btn btn-secondary">
                Open Content
              </Link>
              <Link href="/inbox" className="btn btn-secondary">
                Open Inbox
              </Link>
            </div>
          </div>
        ) : needsData.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No thin samples waiting on more evidence.</p>
        ) : (
          <ul className="space-y-2">
            {needsData.map((p) => (
              <li key={p.id} className="surface-muted flex flex-wrap items-start gap-3 p-4">
                <span className="badge">Not enough data</span>
                <p className="min-w-0 flex-1 text-sm text-[var(--muted)]">{p.label}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
          Recent corrections
        </h2>
        {corrections.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No explicit feedback yet. Approving or dismissing recommendations in Knowledge records
            corrections here.
          </p>
        ) : (
          <ul className="space-y-2">
            {corrections.map((c) => (
              <li key={c.signal} className="surface flex items-center justify-between gap-3 p-4 text-sm">
                <span>{c.copy}</span>
                <span className="badge">{c.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {completedExperiments.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
            Experiment outcomes
          </h2>
          <ul className="space-y-2">
            {completedExperiments.map((ex) => (
              <li key={ex.id} className="surface p-4">
                <p className="font-medium">{ex.name}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">{ex.hypothesis}</p>
                {ex.resultSummary?.message ? (
                  <p className="mt-2 text-sm">{ex.resultSummary.message}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!loading && patterns.length === 0 && feedback.total === 0 ? (
        <EmptyState
          title="Learning starts with activity"
          body="Agent Desk turns conversations, content, and your corrections into business patterns — never invented metrics."
          actions={[
            { href: "/content", label: "Create content", primary: true },
            { href: "/inbox", label: "Work the inbox" },
          ]}
        />
      ) : null}
    </div>
  );
}
