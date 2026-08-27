"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type FeedbackSummary = { total: number; bySignal: Record<string, number> };

type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  status: string;
  primaryMetric: string;
  resultSummary: {
    sampleSize?: number;
    winnerKey?: string | null;
    message?: string;
  } | null;
};

type Candidate = {
  id: string;
  label: string;
  status: string;
  evalSummary: { passed?: boolean; message?: string; caseCount?: number } | null;
};

type EvalRun = {
  id: string;
  suiteKey: string;
  status: string;
  passed: boolean | null;
  createdAt: string;
};

type Backtest = {
  sampleSize: number;
  brierScore: number | null;
  accuracy: number | null;
  message: string;
};

export default function LearningPage() {
  const [feedback, setFeedback] = useState<FeedbackSummary>({ total: 0, bySignal: {} });
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [recentEvals, setRecentEvals] = useState<EvalRun[]>([]);
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [expName, setExpName] = useState("");
  const [expHypothesis, setExpHypothesis] = useState("");
  const [candidateLabel, setCandidateLabel] = useState("");
  const [candidatePrompt, setCandidatePrompt] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/learning");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load learning dashboard");
    setFeedback(json.feedback ?? { total: 0, bySignal: {} });
    setExperiments(json.experiments ?? []);
    setCandidates(json.candidates ?? []);
    setRecentEvals(json.recentEvals ?? []);
    setBacktest(json.forecastBacktest ?? null);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  return (
    <div className="space-y-8">
      <PageHeader
        description="What Agent Desk is learning about your business — only patterns with enough evidence."
        actions={
          <button
            className="btn btn-secondary"
            type="button"
            onClick={async () => {
              try {
                const res = await fetch("/api/learning/evals", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Check failed");
                toast.success(
                  json.evalRun?.passed
                    ? "Quality checks passed"
                    : "Quality checks found issues — see recent runs",
                );
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Check failed");
              }
            }}
          >
            Run quality checks
          </button>
        }
      />

      <section className="grid gap-4 md:grid-cols-2">
        <article className="surface p-4 space-y-2">
          <h2 className="text-lg font-semibold">Recommendation feedback</h2>
          <p className="text-sm text-[var(--muted)]">
            Explicit signals only ({feedback.total} total). Approve/dismiss on Knowledge records feedback.
          </p>
          {feedback.total === 0 ? (
            <p className="text-sm text-[var(--muted)]">No feedback yet.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {Object.entries(feedback.bySignal).map(([signal, count]) => (
                <li key={signal}>
                  <span className="badge mr-2">{signal}</span>
                  {count}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="surface p-4 space-y-2">
          <h2 className="text-lg font-semibold">Forecast backtest</h2>
          {backtest ? (
            <>
              <p className="text-sm text-[var(--muted)]">{backtest.message}</p>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-[var(--muted)]">Samples</dt>
                  <dd className="font-medium">{backtest.sampleSize}</dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Brier</dt>
                  <dd className="font-medium">
                    {backtest.brierScore == null ? "—" : backtest.brierScore.toFixed(3)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Accuracy</dt>
                  <dd className="font-medium">
                    {backtest.accuracy == null ? "—" : `${(backtest.accuracy * 100).toFixed(0)}%`}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Backtest unavailable.</p>
          )}
        </article>
      </section>

      <section className="space-y-3">
        <h2 className="h-display text-2xl">Experiments</h2>
        <form
          className="surface p-4 grid gap-3 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const res = await fetch("/api/learning/experiments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: expName,
                  hypothesis: expHypothesis,
                  primaryMetric: "conversion_rate",
                  variants: [
                    { key: "control", label: "Control" },
                    { key: "treatment", label: "Treatment" },
                  ],
                }),
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "Create failed");
              toast.success("Experiment created (draft)");
              setExpName("");
              setExpHypothesis("");
              await load();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed");
            }
          }}
        >
          <label className="text-sm font-medium">
            Name
            <input
              className="input mt-1"
              value={expName}
              onChange={(e) => setExpName(e.target.value)}
              required
            />
          </label>
          <label className="text-sm font-medium md:col-span-2">
            Hypothesis
            <input
              className="input mt-1"
              value={expHypothesis}
              onChange={(e) => setExpHypothesis(e.target.value)}
              required
            />
          </label>
          <button className="btn btn-secondary" type="submit">
            Create draft experiment
          </button>
        </form>
        {experiments.length === 0 && (
          <p className="text-sm text-[var(--muted)]">No experiments yet.</p>
        )}
        {experiments.map((ex) => (
          <article key={ex.id} className="surface p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{ex.status}</span>
              <p className="font-medium">{ex.name}</p>
            </div>
            <p className="text-sm text-[var(--muted)]">{ex.hypothesis}</p>
            <p className="text-xs text-[var(--muted)]">Metric: {ex.primaryMetric}</p>
            {ex.resultSummary && (
              <p className="text-sm">
                {ex.resultSummary.message}
                {ex.resultSummary.sampleSize
                  ? ` · samples ${ex.resultSummary.sampleSize}`
                  : ""}
                {ex.resultSummary.winnerKey ? ` · winner ${ex.resultSummary.winnerKey}` : ""}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {ex.status === "DRAFT" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const res = await fetch("/api/learning/experiments", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "start", id: ex.id }),
                    });
                    if (!res.ok) {
                      toast.error("Start failed");
                      return;
                    }
                    toast.success("Experiment running");
                    await load();
                  }}
                >
                  Start
                </button>
              )}
              {ex.status === "RUNNING" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const res = await fetch("/api/learning/experiments", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "complete",
                        id: ex.id,
                        sampleSize: 0,
                      }),
                    });
                    if (!res.ok) {
                      toast.error("Complete failed");
                      return;
                    }
                    toast.success("Completed with null metrics (no samples)");
                    await load();
                  }}
                >
                  Complete (no samples)
                </button>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="h-display text-2xl">Agent version candidates</h2>
        <p className="text-sm text-[var(--muted)]">
          Promotion requires a passing eval suite. Failing tests are never skipped.
        </p>
        <form
          className="surface p-4 grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const res = await fetch("/api/learning/agent-versions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  label: candidateLabel,
                  configSnapshot: { systemPromptExtra: candidatePrompt },
                }),
              });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "Create failed");
              toast.success("Candidate created");
              setCandidateLabel("");
              setCandidatePrompt("");
              await load();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed");
            }
          }}
        >
          <label className="text-sm font-medium">
            Label
            <input
              className="input mt-1"
              value={candidateLabel}
              onChange={(e) => setCandidateLabel(e.target.value)}
              required
            />
          </label>
          <label className="text-sm font-medium">
            Candidate system prompt extra
            <textarea
              className="input mt-1 min-h-[80px]"
              value={candidatePrompt}
              onChange={(e) => setCandidatePrompt(e.target.value)}
            />
          </label>
          <button className="btn btn-secondary w-fit" type="submit">
            Create candidate
          </button>
        </form>
        {candidates.map((c) => (
          <article key={c.id} className="surface p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{c.status}</span>
              <p className="font-medium">{c.label}</p>
            </div>
            {c.evalSummary?.message && (
              <p className="text-sm text-[var(--muted)]">{c.evalSummary.message}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {c.status !== "PROMOTED" && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const res = await fetch("/api/learning/agent-versions", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "evaluate", id: c.id }),
                    });
                    const json = await res.json();
                    if (!res.ok) {
                      toast.error(json.error || "Eval failed");
                      return;
                    }
                    toast.success(json.evalRun?.passed ? "Passed" : "Failed");
                    await load();
                  }}
                >
                  Run eval
                </button>
              )}
              {c.status === "PASSED" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    const res = await fetch("/api/learning/agent-versions", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "promote", id: c.id }),
                    });
                    const json = await res.json();
                    if (!res.ok) {
                      toast.error(json.error || "Promote blocked");
                      return;
                    }
                    toast.success("Promoted to active agent config");
                    await load();
                  }}
                >
                  Promote
                </button>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="h-display text-2xl">Recent eval runs</h2>
        {recentEvals.length === 0 && (
          <p className="text-sm text-[var(--muted)]">No eval runs yet.</p>
        )}
        <ul className="space-y-2">
          {recentEvals.map((r) => (
            <li key={r.id} className="surface p-3 text-sm flex flex-wrap gap-2 items-center">
              <span className="badge">{r.status}</span>
              <span>{r.suiteKey}</span>
              <span className="text-[var(--muted)]">
                {r.passed == null ? "—" : r.passed ? "passed" : "failed"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
