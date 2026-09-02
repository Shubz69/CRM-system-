"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

const STEPS = [
  { id: 0, title: "Your business", hint: "What should we call your workspace?" },
  { id: 1, title: "What you do", hint: "In a sentence or two, what do you offer?" },
  { id: 2, title: "Who to reach", hint: "Who are good-fit customers or leads?" },
  { id: 3, title: "Agent behaviour", hint: "How should Agent Desk sound when helping?" },
  { id: 4, title: "Connections", hint: "Optionally link social accounts — you can skip." },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [whatYouDo, setWhatYouDo] = useState("");
  const [whoToReach, setWhoToReach] = useState("");
  const [agentBehaviour, setAgentBehaviour] = useState(
    "Professional, clear, and concise — never pushy.",
  );
  const [socialEnabled, setSocialEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/onboarding/progress");
      const json = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (res.ok) {
        if (json.progress?.completed) {
          router.replace("/home");
          return;
        }
        setBusinessName(json.progress?.businessName || "");
        setWhatYouDo(json.progress?.whatYouDo || "");
        setWhoToReach(json.progress?.whoToReach || "");
        setAgentBehaviour(
          json.progress?.agentBehaviour ||
            "Professional, clear, and concise — never pushy.",
        );
        setStep(json.progress?.currentStep || 0);
        setSocialEnabled(json.socialPolicy?.enabled !== false);
      }
      setLoaded(true);
    })().catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function save(action: "save_progress" | "complete" | "skip_connections") {
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          progress: {
            currentStep: step,
            businessName,
            whatYouDo,
            whoToReach,
            agentBehaviour,
            skippedConnections: action === "skip_connections",
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      if (action === "complete" || action === "skip_connections") {
        toast.success("You're set — welcome to Agent Desk");
        router.push("/home");
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function onNext(e: FormEvent) {
    e.preventDefault();
    if (step < STEPS.length - 1) {
      void save("save_progress").then(() => setStep((s) => s + 1));
      return;
    }
    void save("complete");
  }

  if (!loaded) {
    return (
      <div className="p-8 text-sm text-[var(--muted)]">Loading onboarding…</div>
    );
  }

  const current = STEPS[step]!;

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <PageHeader description="A few short steps so Agent Desk understands your business. You can change everything later." />
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
        Step {step + 1} of {STEPS.length}
      </p>
      <form onSubmit={onNext} className="surface space-y-4 p-5">
        <h2 className="text-xl font-medium">{current.title}</h2>
        <p className="text-sm text-[var(--muted)]">{current.hint}</p>

        {step === 0 ? (
          <input
            className="input"
            required
            minLength={2}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Business or brand name"
          />
        ) : null}
        {step === 1 ? (
          <textarea
            className="input min-h-[120px]"
            required
            minLength={8}
            value={whatYouDo}
            onChange={(e) => setWhatYouDo(e.target.value)}
            placeholder="We help …"
          />
        ) : null}
        {step === 2 ? (
          <textarea
            className="input min-h-[120px]"
            required
            minLength={8}
            value={whoToReach}
            onChange={(e) => setWhoToReach(e.target.value)}
            placeholder="Founders, marketers, agencies…"
          />
        ) : null}
        {step === 3 ? (
          <textarea
            className="input min-h-[120px]"
            required
            minLength={8}
            value={agentBehaviour}
            onChange={(e) => setAgentBehaviour(e.target.value)}
          />
        ) : null}
        {step === 4 ? (
          <div className="space-y-3 text-sm">
            {socialEnabled ? (
              <>
                <p>
                  Link Instagram, LinkedIn, or YouTube when you&apos;re ready. Agent Desk uses
                  your connected accounts — no provider setup required from you.
                </p>
                <Link href="/integrations" className="btn btn-secondary">
                  Open Social Accounts
                </Link>
              </>
            ) : (
              <p className="text-[var(--muted)]">
                Social linking isn&apos;t enabled for this workspace yet. You can continue.
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void save("skip_connections")}
            >
              Skip for now
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-2">
          {step > 0 ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              Back
            </button>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {step === STEPS.length - 1 ? "Finish" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
