"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { toast } from "sonner";
import { HOME_OUTCOME_CARDS } from "@/lib/navigation";
import { looksLikeRawDatabaseError } from "@/lib/user-facing-errors";

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
  kernel?: {
    toolsInvoked: Array<{ toolName: string; durationMs: number | null; error: string | null }>;
    registeredTools: Array<{ name: string; risk: string; description: string }>;
    knowledgeUsed: { documentTitles: string[]; mode: string } | null;
    memoryUsed: { episodeCount: number } | null;
  };
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

function extractFindings(value: unknown): Array<{
  claim: string;
  sourceUrl?: string;
  evidenceExcerpt?: string;
}> {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return [];
  const out: Array<{ claim: string; sourceUrl?: string; evidenceExcerpt?: string }> = [];
  for (const item of obj.findings) {
    if (!item || typeof item !== "object") continue;
    const f = item as { claim?: unknown; sourceUrl?: unknown; evidenceExcerpt?: unknown };
    if (typeof f.claim !== "string") continue;
    out.push({
      claim: f.claim,
      sourceUrl: typeof f.sourceUrl === "string" ? f.sourceUrl : undefined,
      evidenceExcerpt: typeof f.evidenceExcerpt === "string" ? f.evidenceExcerpt : undefined,
    });
  }
  return out;
}

function renderAnswerBody(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Prefer shortAnswer for the lead block; full brief is rendered separately in the UI.
    if (typeof obj.shortAnswer === "string" && obj.shortAnswer.trim()) {
      return obj.shortAnswer.trim();
    }
    if (typeof obj.summary === "string" && obj.summary.trim()) {
      return obj.summary.trim();
    }
    if (typeof obj.echo === "string" && obj.echo.trim()) {
      return obj.echo.trim();
    }
    return "";
  }
  return String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

type ViralExample = {
  title: string;
  whyItWorked: string;
  platform: string;
  sourceUrl: string;
  formatHint?: string;
};

function extractViralExamples(value: unknown): ViralExample[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { viralExamples?: unknown }).viralExamples;
  if (!Array.isArray(raw)) return [];
  const out: ViralExample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.title !== "string" || typeof v.sourceUrl !== "string") continue;
    if (typeof v.whyItWorked !== "string" || typeof v.platform !== "string") continue;
    out.push({
      title: v.title,
      whyItWorked: v.whyItWorked,
      platform: v.platform,
      sourceUrl: v.sourceUrl,
      formatHint: typeof v.formatHint === "string" ? v.formatHint : undefined,
    });
  }
  return out;
}

type NextBigThing = {
  prediction: string;
  whyNow: string;
  howToRideIt: string;
  confidence?: string;
};

function extractNextBigThings(value: unknown): NextBigThing[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { nextBigThings?: unknown }).nextBigThings;
  if (!Array.isArray(raw)) return [];
  const out: NextBigThing[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.prediction !== "string" || typeof v.whyNow !== "string") continue;
    if (typeof v.howToRideIt !== "string") continue;
    out.push({
      prediction: v.prediction,
      whyNow: v.whyNow,
      howToRideIt: v.howToRideIt,
      confidence: typeof v.confidence === "string" ? v.confidence : undefined,
    });
  }
  return out;
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
  const lowAllowanceToastShown = useRef(false);

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
        const json = (await res.json()) as Progress & {
          error?: string;
          code?: string;
        };
        if (res.status === 401 && json.code === "SESSION_ORG_INVALID") {
          toast.error(json.error || "Please sign in again.");
          await signOut({ callbackUrl: "/login" });
          return;
        }
        if (res.status === 401) {
          // Transient next-auth/JWT pool blips — skip this tick instead of toast-spamming.
          return;
        }
        if (res.status === 403 && json.code === "NO_WORKSPACE_MEMBERSHIP") {
          toast.error(
            json.error ||
              "This account isn't linked to a workspace yet. Ask an admin to add you.",
          );
          return;
        }
        if (!res.ok) {
          const msg = json.error || "Could not load progress";
          throw new Error(
            looksLikeRawDatabaseError(msg)
              ? "Something went wrong loading progress. Please try again."
              : msg,
          );
        }
        setProgress(json);
        if (
          !lowAllowanceToastShown.current &&
          json.remainingAllowanceNote &&
          /running low/i.test(json.remainingAllowanceNote)
        ) {
          lowAllowanceToastShown.current = true;
          toast.message(json.remainingAllowanceNote);
        }
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
        const msg = err instanceof Error ? err.message : "Progress check failed";
        toast.error(
          looksLikeRawDatabaseError(msg)
            ? "Something went wrong loading progress. Please try again."
            : msg,
        );
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

  async function handleAskApiFailure(res: Response, json: { error?: string; code?: string }, fallback: string) {
    if (res.status === 401 && json.code === "SESSION_ORG_INVALID") {
      toast.error(json.error || "Please sign in again.");
      await signOut({ callbackUrl: "/login" });
      return;
    }
    if (res.status === 403 && json.code === "NO_WORKSPACE_MEMBERSHIP") {
      toast.error(
        json.error ||
          "This account isn't linked to a workspace yet. Ask an admin to add you.",
      );
      return;
    }
    const msg = json.error || fallback;
    toast.error(
      looksLikeRawDatabaseError(msg)
        ? "Something went wrong starting that request. Please try again."
        : msg,
    );
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
      if (!res.ok) {
        await handleAskApiFailure(res, json, "Could not start");
        return;
      }
      setRunId(json.runId);
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast.error(
        looksLikeRawDatabaseError(msg)
          ? "Something went wrong starting that request. Please try again."
          : msg,
      );
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
      if (!res.ok) {
        await handleAskApiFailure(res, json, "Could not continue");
        return;
      }
      stopPolling();
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast.error(
        looksLikeRawDatabaseError(msg)
          ? "Something went wrong. Please try again."
          : msg,
      );
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
      if (!res.ok) {
        await handleAskApiFailure(res, json, "Could not start generation");
        return;
      }
      stopPolling();
      await poll(json.runId);
      pollRef.current = setInterval(() => void poll(json.runId), 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast.error(
        looksLikeRawDatabaseError(msg)
          ? "Something went wrong. Please try again."
          : msg,
      );
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
  const fullBrief =
    answerSource &&
    typeof answerSource === "object" &&
    typeof (answerSource as { brief?: unknown }).brief === "string"
      ? ((answerSource as { brief: string }).brief || "").trim()
      : "";
  const execSummary =
    answerSource &&
    typeof answerSource === "object" &&
    typeof (answerSource as { summary?: unknown }).summary === "string"
      ? ((answerSource as { summary: string }).summary || "").trim()
      : "";
  const viralExamples = extractViralExamples(answerSource);
  const nextBigThings = extractNextBigThings(answerSource);
  const contentHooks =
    answerSource && typeof answerSource === "object"
      ? asStringArray((answerSource as { contentHooks?: unknown }).contentHooks)
      : [];
  const algorithmNotes =
    answerSource && typeof answerSource === "object"
      ? asStringArray((answerSource as { algorithmNotes?: unknown }).algorithmNotes)
      : [];
  const imageUrl = imageUrlFromOutput(answerSource);
  const sources = extractSources(answerSource);
  const findings = extractFindings(answerSource);
  const adapterErrors =
    answerSource && typeof answerSource === "object" && Array.isArray((answerSource as { adapterErrors?: unknown }).adapterErrors)
      ? ((answerSource as { adapterErrors: Array<{ platform?: string; message?: string }> }).adapterErrors)
      : [];
  const isPartial = progress?.status === "PARTIAL";
  const showAnswer =
    Boolean(
      answerBody ||
        fullBrief ||
        imageUrl ||
        findings.length ||
        viralExamples.length ||
        nextBigThings.length ||
        contentHooks.length,
    ) && ["COMPLETED", "PARTIAL", "FAILED", "RUNNING"].includes(progress?.status || "");

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
        <p className="text-[var(--muted)]">
          Describe the outcome in plain English. You never pick an agent, model, or tier — we route
          that for you.
        </p>
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
        <section className="space-y-6">
          <div className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
              {isPartial ? "What I finished" : "Short answer"}
            </h2>
            {isPartial && progress?.userFacingError && (
              <p className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--foreground)]">
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
            {execSummary && execSummary !== answerBody && (
              <p className="text-sm leading-relaxed text-[var(--muted)]">{execSummary}</p>
            )}
          </div>

          {viralExamples.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Recent viral examples
              </h3>
              <ul className="space-y-3">
                {viralExamples.map((v, i) => (
                  <li key={`${v.sourceUrl}-${i}`} className="surface p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="font-medium text-[var(--foreground)]">{v.title}</p>
                      <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
                        {v.platform}
                        {v.formatHint ? ` · ${v.formatHint}` : ""}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-[var(--muted)]">{v.whyItWorked}</p>
                    <a
                      href={v.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline"
                    >
                      Open video / post
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {nextBigThings.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                What looks next on the algorithm
              </h3>
              <ul className="space-y-3">
                {nextBigThings.map((n, i) => (
                  <li key={`${n.prediction}-${i}`} className="surface p-4">
                    <p className="font-medium text-[var(--foreground)]">{n.prediction}</p>
                    {n.confidence ? (
                      <p className="mt-1 text-xs uppercase tracking-wide text-[var(--muted)]">
                        Confidence: {n.confidence}
                      </p>
                    ) : null}
                    <p className="mt-2 text-sm text-[var(--muted)]">
                      <span className="font-medium text-[var(--foreground)]">Why now:</span> {n.whyNow}
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      <span className="font-medium text-[var(--foreground)]">How to ride it:</span>{" "}
                      {n.howToRideIt}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {contentHooks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Content hooks
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--foreground)]">
                {contentHooks.map((hook, i) => (
                  <li key={`${hook}-${i}`}>{hook}</li>
                ))}
              </ul>
            </div>
          )}

          {algorithmNotes.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Algorithm notes
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                {algorithmNotes.map((note, i) => (
                  <li key={`${note}-${i}`}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {fullBrief && (
            <details className="rounded-xl border border-[var(--border)] px-4 py-3" open>
              <summary className="cursor-pointer text-sm font-medium">Full brief</summary>
              <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]">
                {fullBrief}
              </div>
            </details>
          )}

          {findings.length > 0 && (
            <ul className="space-y-3">
              {findings.map((f, i) => (
                <li key={`${f.claim}-${i}`} className="surface p-4">
                  <p className="text-[var(--foreground)]">{f.claim}</p>
                  {f.evidenceExcerpt ? (
                    <p className="mt-2 text-sm text-[var(--muted)]">{f.evidenceExcerpt}</p>
                  ) : null}
                  {f.sourceUrl ? (
                    <a
                      href={f.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline"
                    >
                      Source
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {adapterErrors.length > 0 && (
            <p className="text-sm text-[var(--muted)]">
              Some sources were skipped:{" "}
              {adapterErrors
                .map((e) => e.message || e.platform)
                .filter(Boolean)
                .slice(0, 4)
                .join(" · ")}
            </p>
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

      {progress?.kernel && (
        <details className="rounded-xl border border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">Agent tools (admin)</summary>
          <div className="mt-3 space-y-3 text-sm text-[var(--muted)]">
            {progress.kernel.knowledgeUsed &&
            progress.kernel.knowledgeUsed.documentTitles.length > 0 ? (
              <p>
                Knowledge used ({progress.kernel.knowledgeUsed.mode}):{" "}
                {progress.kernel.knowledgeUsed.documentTitles.join(" · ")}
              </p>
            ) : (
              <p>No organisation knowledge chunks matched this request.</p>
            )}
            {progress.kernel.memoryUsed ? (
              <p>
                Episodic memory: {progress.kernel.memoryUsed.episodeCount} prior episode
                {progress.kernel.memoryUsed.episodeCount === 1 ? "" : "s"} retrieved.
              </p>
            ) : null}
            {progress.kernel.toolsInvoked.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {progress.kernel.toolsInvoked.map((t, i) => (
                  <li key={`${t.toolName}-${i}`}>
                    {t.toolName}
                    {t.durationMs != null ? ` · ${t.durationMs}ms` : ""}
                    {t.error ? ` · error: ${t.error}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No tool calls recorded on this run yet.</p>
            )}
          </div>
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
