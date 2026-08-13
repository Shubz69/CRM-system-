"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HOME_OUTCOME_CARDS } from "@/lib/navigation";

type Progress = {
  runId: string;
  status: string;
  request: string;
  plainEnglishPlan: string | null;
  clarificationQuestion: string | null;
  clarificationOptions: string[] | null;
  pendingPrompt: string | null;
  pendingCostEstimateCents: number | null;
  pendingCostNote: string | null;
  remainingAllowanceNote: string | null;
  referenceAssetId: string | null;
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

function imageUrlFromOutput(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.url === "string" && obj.url.trim()) {
    // Absolute https, or org-scoped signed content path (/api/assets/…/content?…)
    if (obj.url.startsWith("http") || obj.url.startsWith("/api/assets/")) {
      return obj.url;
    }
  }
  if (typeof obj.assetId === "string" && obj.assetId.trim()) {
    return `/api/assets/${encodeURIComponent(obj.assetId)}/content`;
  }
  return null;
}

type SourceItem = { label: string; url?: string };

function extractSources(value: unknown): SourceItem[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const out: SourceItem[] = [];
  if (Array.isArray(obj.claims)) {
    for (const c of obj.claims) {
      if (!c || typeof c !== "object") continue;
      const claim = (c as { claim?: unknown }).claim;
      const url = (c as { sourceUrl?: unknown }).sourceUrl;
      if (typeof claim === "string") {
        out.push({
          label: claim,
          url: typeof url === "string" ? url : undefined,
        });
      }
    }
  }
  if (Array.isArray(obj.sources)) {
    for (const s of obj.sources) {
      if (!s || typeof s !== "object") continue;
      const title = (s as { title?: unknown }).title;
      const url = (s as { url?: unknown }).url;
      if (typeof url === "string") {
        out.push({
          label: typeof title === "string" ? title : url,
          url,
        });
      }
    }
  }
  return out;
}

function renderAnswerBody(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.summary === "string") return obj.summary;
    if (typeof obj.echo === "string") return obj.echo;
    return "";
  }
  return String(value);
}

function WorkingPulse({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 px-4 py-3">
      <span className="mt-1.5 flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:300ms]" />
      </span>
      <div>
        <p className="text-sm font-medium text-[var(--foreground)]">{label}</p>
        <p className="mt-0.5 text-xs text-[var(--muted)]">Working — this updates as each step finishes.</p>
      </div>
    </div>
  );
}

export default function AskPage() {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [referenceAssetId, setReferenceAssetId] = useState<string | null>(null);
  const [referenceName, setReferenceName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editablePrompt, setEditablePrompt] = useState("");
  const [wantImageUpload, setWantImageUpload] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
        if (json.status === "AWAITING_PROMPT_CONFIRM" && json.pendingPrompt) {
          setEditablePrompt(json.pendingPrompt);
        }
        if (
          json.status === "COMPLETED" ||
          json.status === "PARTIAL" ||
          json.status === "FAILED" ||
          json.status === "CANCELLED" ||
          json.status === "AWAITING_CLARIFICATION" ||
          json.status === "AWAITING_PROMPT_CONFIRM"
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

  function applyOutcome(card: (typeof HOME_OUTCOME_CARDS)[number]) {
    if (card.href) {
      router.push(card.href);
      return;
    }
    if (card.id === "image") {
      setWantImageUpload(true);
    }
    if (card.prefill) {
      setRequest(card.prefill);
      inputRef.current?.focus();
    }
  }

  async function onUpload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/assets", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      setReferenceAssetId(json.assetId);
      setReferenceName(file.name);
      toast.success("Reference image ready — describe what you want.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function startRun(text: string) {
    setSubmitting(true);
    setProgress(null);
    stopPolling();
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: text,
          ...(referenceAssetId ? { referenceAssetId } : {}),
        }),
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = request.trim();
    if (!text) return;
    await startRun(text);
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

  async function onConfirmPrompt() {
    if (!runId || !editablePrompt.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/ask", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, confirmedPrompt: editablePrompt.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not start generation");
      stopPolling();
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 1200);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveToKnowledge() {
    const source = progress?.finalOutput ?? progress?.outputSoFar;
    const body = renderAnswerBody(source);
    if (!body.trim()) {
      toast.error("Nothing to save yet.");
      return;
    }
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Research draft — ${new Date().toLocaleDateString()}`,
          category: "research",
          content: body,
          tags: ["draft", "from-ask"],
          status: "INACTIVE",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save");
      toast.success("Saved to Knowledge as a draft.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function onNextAction(action: string) {
    const cleaned = (progress?.request || request).replace(/\n\n\[User chose:.*$/, "");
    if (action === "Ask something else") {
      setProgress(null);
      setRunId(null);
      setEditablePrompt("");
      setRequest("");
      inputRef.current?.focus();
      return;
    }
    if (action === "Try again" || action === "Run this again" || action === "Run this again next month") {
      setRequest(cleaned);
      setProgress(null);
      setRunId(null);
      await startRun(cleaned);
      return;
    }
    if (action === "Rephrase your request") {
      setRequest(cleaned);
      setProgress(null);
      setRunId(null);
      inputRef.current?.focus();
      return;
    }
    if (action === "Turn this into content") {
      const summary = renderAnswerBody(progress?.finalOutput ?? progress?.outputSoFar);
      const seeded = `Write content based on this brief:\n\n${summary.slice(0, 3500)}`;
      setRequest(seeded);
      setProgress(null);
      setRunId(null);
      inputRef.current?.focus();
      return;
    }
    if (action === "Save to Knowledge") {
      await saveToKnowledge();
      return;
    }
    if (action === "Make another image") {
      setWantImageUpload(true);
      setRequest("Make something like this reference: ");
      setProgress(null);
      setRunId(null);
      inputRef.current?.focus();
      return;
    }
  }

  const answerSource =
    progress?.finalOutput != null ? progress.finalOutput : progress?.outputSoFar;
  const answerBody = answerSource != null ? renderAnswerBody(answerSource) : "";
  const imageUrl = imageUrlFromOutput(answerSource);
  const sources = extractSources(answerSource);
  const isPartial = progress?.status === "PARTIAL";
  const showAnswer =
    Boolean(answerBody || imageUrl) &&
    ["COMPLETED", "PARTIAL", "FAILED", "RUNNING"].includes(progress?.status || "");

  const isLive =
    progress && ["PENDING", "PLANNING", "RUNNING"].includes(progress.status);

  const workingLabel =
    progress?.currentStep?.userFacingLabel ||
    progress?.plainEnglishPlan ||
    "Figuring out the best approach";

  const showHomeCards = !progress && !submitting;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {showHomeCards && (
        <div>
          <h1 className="sr-only">What do you need?</h1>
          <p className="text-[var(--muted)]">
            Describe the outcome in plain English. You never pick an agent, model, or tier —
            we route that for you.
          </p>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <label htmlFor="ask-request" className="text-sm font-medium text-[var(--foreground)]">
          What do you need?
        </label>
        <textarea
          ref={inputRef}
          id="ask-request"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={4}
          placeholder="Research plant hire pricing in the UK…"
          className="input min-h-[7rem] resize-y text-base"
          disabled={submitting}
        />

        {(wantImageUpload || referenceAssetId) && (
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploading || submitting}
              onClick={() => fileRef.current?.click()}
              className="btn btn-secondary"
            >
              {uploading ? "Uploading…" : "Upload reference image"}
            </button>
            {referenceName && (
              <span className="text-sm text-[var(--muted)]">
                Using {referenceName}
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => {
                    setReferenceAssetId(null);
                    setReferenceName(null);
                  }}
                >
                  Clear
                </button>
              </span>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !request.trim()}
          className="btn btn-primary disabled:opacity-50"
        >
          {submitting ? "Starting…" : "Go"}
        </button>
      </form>

      {showHomeCards && (
        <div className="grid gap-3 sm:grid-cols-2">
          {HOME_OUTCOME_CARDS.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => applyOutcome(card)}
              className="surface-interactive rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition"
            >
              <p className="font-medium text-[var(--foreground)]">{card.title}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{card.hint}</p>
            </button>
          ))}
        </div>
      )}

      {progress?.plainEnglishPlan && (
        <p className="rounded-xl bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--foreground)]">
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
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-sm hover:border-[var(--accent)]"
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      {progress?.status === "AWAITING_PROMPT_CONFIRM" && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Review prompt before generating
          </h2>
          <p className="text-sm text-[var(--muted)]">
            Edit anything that looks off. Generation starts only after you confirm.
          </p>
          <textarea
            value={editablePrompt}
            onChange={(e) => setEditablePrompt(e.target.value)}
            rows={6}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            disabled={submitting}
          />
          {progress.pendingCostNote && (
            <p className="text-sm font-medium">{progress.pendingCostNote}</p>
          )}
          {progress.remainingAllowanceNote && (
            <p className="text-sm text-[var(--muted)]">{progress.remainingAllowanceNote}</p>
          )}
          <button
            type="button"
            disabled={submitting || editablePrompt.trim().length < 8}
            onClick={() => void onConfirmPrompt()}
            className="btn btn-primary disabled:opacity-50"
          >
            {submitting ? "Starting generation…" : "Confirm & generate"}
          </button>
        </div>
      )}

      {/* Answer at the top */}
      {showAnswer && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            {isPartial ? "What I finished" : "Answer"}
          </h2>
          {isPartial && progress?.userFacingError && (
            <p className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm text-[var(--foreground)]">
              {progress.userFacingError}
            </p>
          )}
          {imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt="Generated image"
              className="max-h-[28rem] w-full rounded-xl object-contain"
            />
          )}
          {answerBody && (
            <div className="whitespace-pre-wrap text-lg leading-relaxed">{answerBody}</div>
          )}
          {!isPartial && progress?.userFacingError && !answerBody && !imageUrl && (
            <p className="text-sm text-[var(--muted)]">{progress.userFacingError}</p>
          )}
        </section>
      )}

      {!showAnswer && progress?.userFacingError && progress.status === "FAILED" && (
        <p className="text-sm text-[var(--muted)]">{progress.userFacingError}</p>
      )}

      {isLive && (
        <WorkingPulse label={workingLabel} />
      )}

      {sources.length > 0 && (
        <details className="rounded-xl border border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">Where this came from</summary>
          <ul className="mt-3 space-y-2 text-sm">
            {sources.map((s, i) => (
              <li key={`${s.label}-${i}`}>
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    {s.label}
                  </a>
                ) : (
                  s.label
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {progress && progress.stepsDetailCleared && (
        <p className="text-sm text-[var(--muted)]">
          {progress.stepsDetailClearedMessage ||
            "Detailed steps were cleared after 30 days — the brief is saved."}
        </p>
      )}

      {progress && progress.steps.length > 0 && !progress.stepsDetailCleared && (
        <details className="rounded-xl border border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Details
            {progress.costNote ? ` · ${progress.costNote}` : ""}
            {progress.remainingAllowanceNote ? ` · ${progress.remainingAllowanceNote}` : ""}
            {` · ${formatElapsed(progress.elapsedMs)}`}
          </summary>
          <ol className="mt-3 space-y-2">
            {progress.steps.map((step) => (
              <li key={step.position} className="text-sm">
                <span className="font-medium">{step.userFacingLabel}</span>
                <span className="text-[var(--muted)]">
                  {" "}
                  — {step.userFacingStatus || "done"}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {progress &&
        ["COMPLETED", "PARTIAL", "FAILED"].includes(progress.status) &&
        progress.nextActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {progress.nextActions.map((action) => (
              <button
                key={action}
                type="button"
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--accent)]"
                onClick={() => void onNextAction(action)}
              >
                {action}
              </button>
            ))}
            {progress.status === "COMPLETED" && (
              <Link
                href="/knowledge"
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--accent)]"
              >
                Open Knowledge
              </Link>
            )}
          </div>
        )}
    </div>
  );
}
