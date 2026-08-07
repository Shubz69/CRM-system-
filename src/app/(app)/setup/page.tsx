"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

export default function SetupAssistantPage() {
  const [description, setDescription] = useState(
    "We sell AI automation systems to UK SMEs. Leads should generally have a business, decision-making authority and genuine interest in improving operations. Book qualified leads onto a call.",
  );
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  async function propose(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/setup-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "propose", businessDescription: description }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Setup assistant failed");
      setProposal(json.proposal);
      toast.success("Claude proposed a configuration");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!proposal) return;
    setBusy(true);
    try {
      const res = await fetch("/api/setup-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", proposal }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Approve failed");
      toast.success("Setup approved and saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">AI Setup Assistant</h1>
        <p className="mt-1 text-[var(--muted)]">
          Describe your business. Claude proposes qualification, scoring, tone, and knowledge — you approve.
        </p>
      </div>

      <form onSubmit={propose} className="surface space-y-3 p-5">
        <label className="block text-sm font-medium">
          Tell us about your business
          <textarea
            className="input mt-2 min-h-[160px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            minLength={20}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Ask Claude to configure
        </button>
      </form>

      {proposal && (
        <section className="surface p-5">
          <h2 className="h-display text-2xl">Here&apos;s what I&apos;ve configured</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Review the proposal. Nothing is saved until you approve.
          </p>
          <pre className="mt-4 max-h-[420px] overflow-auto rounded-xl bg-[var(--surface-2)] p-4 text-xs">
            {JSON.stringify(proposal, null, 2)}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              Approve Setup
            </button>
            <Link href="/agent" className="btn btn-secondary">
              Open AI Operator
            </Link>
            <Link href="/settings/go-live" className="btn btn-secondary">
              Go Live checklist
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
