"use client";

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
