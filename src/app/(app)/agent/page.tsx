"use client";

import { PermissionGate } from "@/components/permission-gate";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { PageError, PageLoading } from "@/components/ui/page-state";

type AgentConfig = {
  id: string;
  brandTone: string;
  formality: string;
  responseLength: string;
  emojiUsage: string;
  confidenceThreshold: number;
  bookingUrl: string | null;
  maxFollowUps: number;
  qualificationQuestions: string[];
  restrictedTopics: string[];
};

/** Stored questions → textarea text, one question per line. */
function questionsToText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((q): q is string => typeof q === "string" && q.trim().length > 0).join("\n")
    : "";
}

/** Textarea text → one question per non-empty line. */
function textToQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((q) => q.trim())
    .filter(Boolean);
}

function AgentPageContent() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  // Raw textarea text: splitting on every keystroke dropped the trailing newline, so Enter
  // never created a new line and "Q1⏎Q2" saved as "Q1Q2". Split only when saving.
  const [questionsText, setQuestionsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playgroundInput, setPlaygroundInput] = useState(
    "How much does it cost for a coaching business?",
  );
  const [playgroundOutput, setPlaygroundOutput] = useState<string>("");

  function loadConfig() {
    setLoadError(null);
    fetch("/api/agent")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setConfig(j.config);
        setQuestionsText(questionsToText(j.config?.qualificationQuestions));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load agent"));
  }

  useEffect(() => {
    loadConfig();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!config) return;
    setSaving(true);
    try {
      const res = await fetch("/api/agent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandTone: config.brandTone,
          formality: config.formality,
          responseLength: config.responseLength,
          emojiUsage: config.emojiUsage,
          confidenceThreshold: config.confidenceThreshold,
          bookingUrl: config.bookingUrl?.trim() || null,
          maxFollowUps: config.maxFollowUps,
          qualificationQuestions: textToQuestions(questionsText),
          restrictedTopics: config.restrictedTopics,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Save failed");
        return;
      }
      setConfig(json.config);
      setQuestionsText(questionsToText(json.config?.qualificationQuestions));
      toast.success("Agent configuration saved");
    } catch {
      toast.error("Save failed — check your connection and try again");
    } finally {
      setSaving(false);
    }
  }

  async function runPlayground(e: FormEvent) {
    e.preventDefault();
    setPlaygroundOutput("Running…");
    const res = await fetch("/api/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: playgroundInput,
        contactExternalId: `playground_${Date.now()}`,
        instagramUsername: "playground_lead",
        fullName: "Playground Lead",
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setPlaygroundOutput(json.error || "Failed");
      return;
    }
    setPlaygroundOutput(JSON.stringify(json.result, null, 2));
  }

  if (loadError) return <PageError message={loadError} onRetry={loadConfig} />;
  if (!config) return <PageLoading label="Loading agent configuration" />;

  return (
    <div className="space-y-6">
      <PageHeader description="Tune brand voice, reply tone, and automation behaviour for your workspace." />

      <div className="surface flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Agent Desk intelligence</p>
          <p className="font-[family-name:var(--font-fraunces)] text-2xl">AI behaviour</p>
          <p className="text-sm text-[var(--muted)]">Brand voice and reply preferences</p>
        </div>
        <span className="badge">Workspace</span>
      </div>

      <form onSubmit={save} className="surface grid gap-4 p-5 md:grid-cols-2">
        <label className="text-sm font-medium md:col-span-2">
          Brand tone
          <input
            className="input mt-2"
            value={config.brandTone}
            onChange={(e) => setConfig({ ...config, brandTone: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium">
          Formality
          <input
            className="input mt-2"
            value={config.formality}
            onChange={(e) => setConfig({ ...config, formality: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium">
          Response length
          <input
            className="input mt-2"
            value={config.responseLength}
            onChange={(e) => setConfig({ ...config, responseLength: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium">
          Emoji usage
          <input
            className="input mt-2"
            value={config.emojiUsage}
            onChange={(e) => setConfig({ ...config, emojiUsage: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium">
          Confidence threshold
          <input
            className="input mt-2"
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={config.confidenceThreshold}
            onChange={(e) =>
              setConfig({ ...config, confidenceThreshold: Number(e.target.value) })
            }
          />
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Booking URL
          <input
            className="input mt-2"
            type="url"
            inputMode="url"
            placeholder="https://calendly.com/your-name/intro-call"
            value={config.bookingUrl || ""}
            onChange={(e) => setConfig({ ...config, bookingUrl: e.target.value })}
          />
          <span className="mt-1 block text-xs font-normal text-[var(--muted)]">
            Full link starting with https:// — leave empty to use the default booking link.
          </span>
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Qualification questions (one per line)
          <textarea
            className="input mt-2 min-h-28"
            rows={5}
            placeholder={"What's your budget?\nWhen are you looking to start?"}
            value={questionsText}
            onChange={(e) => setQuestionsText(e.target.value)}
          />
          <span className="mt-1 block text-xs font-normal text-[var(--muted)]">
            Press Enter to start a new question. Blank lines are ignored.
          </span>
        </label>
        <button className="btn btn-primary md:col-span-2" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save configuration"}
        </button>
      </form>

      <form onSubmit={runPlayground} className="surface space-y-3 p-5">
        <h2 className="h-display text-2xl">Testing playground</h2>
        <label className="block text-sm font-medium">
          Lead message
          <textarea
            className="input mt-2 min-h-28"
            value={playgroundInput}
            onChange={(e) => setPlaygroundInput(e.target.value)}
          />
        </label>
        <button className="btn btn-secondary" type="submit">
          Simulate lead message
        </button>
        {playgroundOutput && (
          <pre className="overflow-x-auto rounded-xl bg-[var(--surface-2)] p-4 text-xs">
            {playgroundOutput}
          </pre>
        )}
      </form>
    </div>
  );
}

export default function AgentPage() {
  return (
    <PermissionGate
      permission="agent:manage"
      title="AI Agent"
      message="Only workspace owners and admins change the AI agent's settings."
    >
      <AgentPageContent />
    </PermissionGate>
  );
}
