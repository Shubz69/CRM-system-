"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

export default function SimulatorPage() {
  const [text, setText] = useState(
    "Hi! I run an online coaching business and get about 500 Instagram DMs a month. How much does this cost? I'd like to book a call.",
  );
  const [username, setUsername] = useState("coach_maya");
  const [externalId, setExternalId] = useState("sim_lead_001");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          instagramUsername: username,
          contactExternalId: externalId,
          fullName: username.replace(/_/g, " "),
          campaignSource: "simulator",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Simulation failed");
      setResult(json.result);
      toast.success(json.result.duplicate ? "Duplicate event ignored" : "Message processed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="h-display text-4xl">Conversation simulator</h1>
        <p className="mt-1 text-[var(--muted)]">
          Push a real inbound message through the live pipeline for this workspace (no ManyChat
          required). Rows are marked origin = simulator so you can tell them apart later.
        </p>
      </div>

      <form onSubmit={onSubmit} className="surface space-y-4 p-6">
        <label className="block text-sm font-medium">
          Instagram username
          <input className="input mt-2" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block text-sm font-medium">
          Contact external ID
          <input
            className="input mt-2"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          Lead message
          <textarea
            className="input mt-2 min-h-36"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </label>
        <button className="btn btn-primary" disabled={loading} type="submit">
          {loading ? "Processing…" : "Send simulated DM"}
        </button>
      </form>

      {result && (
        <div className="surface space-y-3 p-6">
          <h2 className="h-display text-2xl">Result</h2>
          <pre className="overflow-x-auto rounded-xl bg-[var(--surface-2)] p-4 text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
          {typeof result.conversationId === "string" && (
            <Link className="btn btn-secondary" href={`/inbox?c=${result.conversationId}`}>
              Open in inbox
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
