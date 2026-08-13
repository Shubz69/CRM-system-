"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Progress = {
  runId: string;
  status: string;
  request: string;
  plainEnglishPlan: string | null;
  clarificationQuestion: string | null;
  clarificationOptions: string[] | null;
  currentStep: {
    position: number;
    userFacingLabel: string;
    userFacingStatus: string | null;
    status: string;
  } | null;
  stepsCompleted: number;
  stepsTotal: number;
  elapsedMs: number;
  totalCostCents: number;
  costNote: string | null;
  outputSoFar: unknown;
  finalOutput: unknown;
  userFacingError: string | null;
  stepsDetailCleared?: boolean;
  stepsDetailClearedMessage?: string | null;
  steps: Array<{
    position: number;
    userFacingLabel: string;
    userFacingStatus: string | null;
    status: string;
    output: unknown;
    costCents: number;
    detailRetention?: string;
  }>;
  nextActions: string[];
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderAnswer(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.summary === "string") {
      const claims = Array.isArray(obj.claims)
        ? obj.claims
            .map((c) => {
              if (!c || typeof c !== "object") return null;
              const claim = (c as { claim?: unknown; sourceUrl?: unknown }).claim;
              const url = (c as { claim?: unknown; sourceUrl?: unknown }).sourceUrl;
              if (typeof claim !== "string") return null;
              return typeof url === "string" ? `• ${claim} (${url})` : `• ${claim}`;
            })
            .filter(Boolean)
            .join("\n")
        : "";
      const gaps = Array.isArray(obj.gaps)
        ? obj.gaps.filter((g): g is string => typeof g === "string").map((g) => `• ${g}`).join("\n")
        : "";
      const unsupported = Array.isArray(obj.unsupportedClaims)
        ? obj.unsupportedClaims
            .map((c) => {
              if (!c || typeof c !== "object") return null;
              const claim = (c as { claim?: unknown }).claim;
              return typeof claim === "string" ? `• ${claim}` : null;
            })
            .filter(Boolean)
            .join("\n")
        : "";
      return [
        obj.summary,
        claims ? `\nClaims\n${claims}` : "",
        gaps ? `\nGaps\n${gaps}` : "",
        unsupported ? `\nNeeds a source\n${unsupported}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (typeof obj.echo === "string") return obj.echo;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export default function AskPage() {
  const [request, setRequest] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/ask/${id}`);
        const json = (await res.json()) as Progress & { error?: string };
        if (!res.ok) throw new Error(json.error || "Could not load progress");
        setProgress(json);
        if (
          json.status === "COMPLETED" ||
          json.status === "PARTIAL" ||
          json.status === "FAILED" ||
          json.status === "CANCELLED" ||
          json.status === "AWAITING_CLARIFICATION"
        ) {
          stopPolling();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Progress check failed");
      }
    },
    [stopPolling],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = request.trim();
    if (!text) return;
    setSubmitting(true);
    setProgress(null);
    stopPolling();
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not start");
      setRunId(json.runId);
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 1200);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function onClarify(option: string) {
    if (!runId) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/ask", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, selectedOption: option }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not continue");
      stopPolling();
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 1200);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  const answer =
    progress?.finalOutput != null
      ? renderAnswer(progress.finalOutput)
      : progress?.outputSoFar != null
        ? renderAnswer(progress.outputSoFar)
        : "";

  const isLive =
    progress &&
    ["PENDING", "PLANNING", "RUNNING"].includes(progress.status);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="h-display text-4xl">Ask</h1>
        <p className="mt-2 text-[var(--muted)]">
          Describe what you need in plain English. We&apos;ll show each step as it
          happens — no setup required.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <label htmlFor="ask-request" className="sr-only">
          Your request
        </label>
        <textarea
          id="ask-request"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={5}
          placeholder='Try: “Summarise this: We offer dental implants…” or “Echo: hello from the clinic”'
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-base outline-none focus:border-[var(--accent)]"
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={submitting || !request.trim()}
          className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Starting…" : "Go"}
        </button>
      </form>

      {progress?.plainEnglishPlan && (
        <p className="rounded-lg bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--foreground)]">
          {progress.plainEnglishPlan}
        </p>
      )}

      {progress?.status === "AWAITING_CLARIFICATION" && progress.clarificationQuestion && (
        <div className="space-y-3">
          <p className="text-base font-medium">{progress.clarificationQuestion}</p>
          <div className="flex flex-col gap-2">
            {(progress.clarificationOptions || []).map((opt) => (
              <button
                key={opt}
                type="button"
                disabled={submitting}
                onClick={() => void onClarify(opt)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-sm hover:border-[var(--accent)]"
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Answer first */}
      {answer && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Answer
          </h2>
          <div className="whitespace-pre-wrap text-lg leading-relaxed">{answer}</div>
          {progress?.userFacingError && (
            <p className="text-sm text-[var(--muted)]">{progress.userFacingError}</p>
          )}
        </section>
      )}

      {!answer && progress?.userFacingError && (
        <p className="text-sm text-[var(--muted)]">{progress.userFacingError}</p>
      )}

      {isLive && !answer && (
        <p className="text-sm text-[var(--muted)]">
          Working
          {progress.currentStep
            ? ` — ${progress.currentStep.userFacingLabel}`
            : progress.plainEnglishPlan
              ? ""
              : " — figuring out the best approach"}
          …
        </p>
      )}

      {/* Details collapse underneath — brief stays above when detail was pruned */}
      {progress && progress.stepsDetailCleared && (
        <p className="text-sm text-[var(--muted)]">
          {progress.stepsDetailClearedMessage ||
            "Detailed steps were cleared after 30 days — the brief is saved."}
        </p>
      )}

      {progress && progress.steps.length > 0 && !progress.stepsDetailCleared && (
        <details className="rounded-lg border border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Steps ({progress.stepsCompleted}/{progress.stepsTotal || progress.steps.length}) ·{" "}
            {formatElapsed(progress.elapsedMs)}
            {progress.costNote ? ` · ${progress.costNote}` : ""}
          </summary>
          <ol className="mt-3 space-y-2">
            {progress.steps.map((step) => (
              <li key={step.position} className="text-sm">
                <span className="font-medium">{step.userFacingLabel}</span>
                <span className="text-[var(--muted)]">
                  {" "}
                  — {step.userFacingStatus || step.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {progress && progress.steps.length > 0 && progress.stepsDetailCleared && (
        <div className="text-sm text-[var(--muted)]">
          <p>
            {progress.stepsCompleted} step
            {progress.stepsCompleted === 1 ? "" : "s"} completed ·{" "}
            {formatElapsed(progress.elapsedMs)}
            {progress.costNote ? ` · ${progress.costNote}` : ""}
          </p>
        </div>
      )}

      {progress &&
        ["COMPLETED", "PARTIAL", "FAILED"].includes(progress.status) &&
        progress.nextActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
              onClick={() => {
                const cleaned = progress.request.replace(/\n\n\[User chose:.*$/, "");
                setRequest(cleaned);
                setProgress(null);
                setRunId(null);
              }}
            >
              Ask something else
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
              onClick={() => {
                const cleaned = progress.request.replace(/\n\n\[User chose:.*$/, "");
                setRequest(cleaned);
                setProgress(null);
                setRunId(null);
                // User taps Go again — keeps the one-input flow obvious.
              }}
            >
              Edit &amp; run again
            </button>
          </div>
        )}
    </div>
  );
}
