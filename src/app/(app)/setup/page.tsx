"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

function formatProposalValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value
      .map((item) => (item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)))
      .join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries.map(([k, v]) => `${k}: ${formatProposalValue(v)}`).join(" · ");
  }
  return String(value);
}

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
      toast.success("Agent Desk proposed a configuration");
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
      <PageHeader description="One-time onboarding helper: describe your business, review the proposed agent tone, qualification questions, and starter knowledge, then approve to save." />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-4 py-3 text-sm text-[var(--muted)]">
        <p className="font-medium text-[var(--foreground)]">What this is for</p>
        <p className="mt-1">
          Speeds up first-time setup of the AI Operator (tone, how leads are scored, and a few Knowledge
          docs). You can skip it and configure those manually under{" "}
          <Link href="/agent" className="text-[var(--accent)] underline-offset-2 hover:underline">
            AI Agent
          </Link>{" "}
          and{" "}
          <Link href="/knowledge" className="text-[var(--accent)] underline-offset-2 hover:underline">
            Knowledge
          </Link>
          .
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
            placeholder="What you sell, who it’s for, and what a good lead looks like…"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Configuring…" : "Propose configuration"}
        </button>
      </form>

      {proposal && (
        <section className="surface p-5">
          <h2 className="h-display text-2xl">Here&apos;s what I&apos;ve configured</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Review the proposal. Nothing is saved until you approve.
          </p>
          <dl className="mt-4 divide-y divide-[var(--border)]/60">
            {Object.entries(proposal).map(([key, value]) => (
              <div key={key} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
                <dt className="text-sm font-medium">{key}</dt>
                <dd className="text-sm text-[var(--muted)]">{formatProposalValue(value)}</dd>
              </div>
            ))}
          </dl>
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
