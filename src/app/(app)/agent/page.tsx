"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { PageError, PageLoading } from "@/components/ui/page-state";

type AgentConfig = {
  id: string;
  aiProvider: string;
  model: string;
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

export default function AgentPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
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
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load agent"));
  }

  useEffect(() => {
    loadConfig();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!config) return;
    const res = await fetch("/api/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiProvider: config.aiProvider,
        model: config.model,
        brandTone: config.brandTone,
        formality: config.formality,
        responseLength: config.responseLength,
        emojiUsage: config.emojiUsage,
        confidenceThreshold: config.confidenceThreshold,
        bookingUrl: config.bookingUrl,
        maxFollowUps: config.maxFollowUps,
        qualificationQuestions: config.qualificationQuestions,
        restrictedTopics: config.restrictedTopics,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Save failed");
      return;
    }
    setConfig(json.config);
    toast.success("Agent configuration saved");
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
      <PageHeader description="Powered by Claude. Tune tone and goals — model routing stays under the hood." />

      <div className="surface flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">AI Operator</p>
          <p className="font-[family-name:var(--font-fraunces)] text-2xl">Claude</p>
          <p className="text-sm text-[var(--muted)]">
            {config.aiProvider === "anthropic" || config.aiProvider === "mock"
              ? "Ready"
              : `Provider: ${config.aiProvider}`}
          </p>
        </div>
        <span className="badge">Anthropic</span>
      </div>

      <form onSubmit={save} className="surface grid gap-4 p-5 md:grid-cols-2">
        <details className="md:col-span-2 rounded-xl border border-[var(--border)] p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced Settings</summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium">
              Provider
              <select
                className="input mt-2"
                value={config.aiProvider === "openai" ? "anthropic" : config.aiProvider}
                onChange={(e) => setConfig({ ...config, aiProvider: e.target.value })}
              >
                <option value="anthropic">Claude (Anthropic) — recommended</option>
                <option value="mock">Mock (local testing only)</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              Model override (optional)
              <input
                className="input mt-2"
                value={config.model}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                placeholder="Leave as Claude default unless needed"
              />
            </label>
            <p className="md:col-span-2 text-xs text-[var(--muted)]">
              OpenAI is not required. Model tiers (economy / default / advanced) are managed by
              Autopilot and Super Admin AI Router.
            </p>
          </div>
        </details>
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
            value={config.bookingUrl || ""}
            onChange={(e) => setConfig({ ...config, bookingUrl: e.target.value })}
          />
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Qualification questions (one per line)
          <textarea
            className="input mt-2 min-h-28"
            value={(config.qualificationQuestions || []).join("\n")}
            onChange={(e) =>
              setConfig({
                ...config,
                qualificationQuestions: e.target.value.split("\n").filter(Boolean),
              })
            }
          />
        </label>
        <button className="btn btn-primary md:col-span-2" type="submit">
          Save configuration
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
