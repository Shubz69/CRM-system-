"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageShell, SectionCard } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";

type Briefing = {
  items: Array<{
    id: string;
    title: string;
    detail: string;
    href: string;
    severity: string;
  }>;
  nextActions: Array<{ label: string; href: string; detail?: string }>;
  setupNeeded: boolean;
  phase13?: {
    goalsAtRisk?: number;
    openOpportunities?: number;
    activeGoals?: number;
  } | null;
};

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const router = useRouter();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [askDraft, setAskDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);

  useEffect(() => {
    fetch("/api/chief-of-staff")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((json) => {
        if (json) setBriefing(json as Briefing);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  function onAsk(e: FormEvent) {
    e.preventDefault();
    const q = askDraft.trim();
    if (!q) {
      router.push("/ask");
      return;
    }
    router.push(`/ask?q=${encodeURIComponent(q)}`);
  }

  const attention = briefing?.items ?? [];
  const actions = briefing?.nextActions ?? [];
  const setupNeeded = Boolean(briefing?.setupNeeded);
  const statusLine = setupNeeded
    ? "Setup is incomplete — finish Integrations to unlock the full desk."
    : attention.length > 0
      ? `${attention.length} item${attention.length === 1 ? "" : "s"} need your attention.`
      : "Nothing urgent. Here is where commercial work lives today.";

  if (loading) {
    return (
      <PageShell>
        <PageLoading label="Loading today" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="space-y-1">
        <p className="caption">Command centre</p>
        <p className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight text-[var(--foreground)] md:text-4xl">
          {greeting}
        </p>
        <p className="max-w-2xl text-sm text-[var(--muted)] md:text-base">{statusLine}</p>
      </div>

      {setupNeeded ? (
        <div className="surface border-[color-mix(in_oklab,var(--accent)_35%,var(--border))] p-5 md:p-6">
          <p className="section-title">Finish setup to go live</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Connect messaging, confirm booking, and verify AI — then Agent Desk can work your
            conversations.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/integrations" className="btn btn-primary">
              Open Integrations
            </Link>
            <Link href="/settings/go-live" className="btn btn-secondary">
              Setup progress
            </Link>
            <Link href="/setup" className="btn btn-secondary">
              Guided assistant
            </Link>
          </div>
        </div>
      ) : null}

      <form onSubmit={onAsk} className="surface p-5 md:p-6">
        <label className="card-title block" htmlFor="home-ask">
          Ask Agent Desk
        </label>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Research, messaging help, content ideas, or a briefing — outcomes, not jargon.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            id="home-ask"
            className="input flex-1"
            placeholder="e.g. What needs my attention in the inbox?"
            value={askDraft}
            onChange={(e) => setAskDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-primary shrink-0">
            Ask
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Or open{" "}
          <Link href="/ask" className="underline underline-offset-2 hover:text-[var(--foreground)]">
            full Ask
          </Link>{" "}
          for guided outcome prompts.
        </p>
      </form>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <SectionCard
          title="Needs attention"
          actions={
            <Link href="/attention" className="meta hover:text-[var(--foreground)]">
              View all
            </Link>
          }
        >
          {attention.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              Nothing urgent. Check Inbox or Opportunities when you are ready.
            </p>
          ) : (
            <ul className="space-y-2">
              {attention.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="block rounded-xl border border-[var(--border)] px-3 py-3 transition hover:bg-[var(--surface-2)]"
                  >
                    <span className="card-title block">{item.title}</span>
                    <span className="meta mt-1 block leading-relaxed">{item.detail}</span>
                    {item.severity === "high" || item.severity === "critical" ? (
                      <span className="badge badge-warn mt-2">Priority</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recommended actions">
          {actions.length === 0 ? (
            <EmptyState
              title="You're clear"
              body="When there is something useful to do, it will show up here."
              actions={[
                { href: "/inbox", label: "Open Inbox", primary: true },
                { href: "/growth", label: "Explore Growth" },
              ]}
            />
          ) : (
            <ul className="space-y-3">
              {actions.slice(0, 5).map((action) => (
                <li
                  key={`${action.href}-${action.label}`}
                  className="rounded-xl border border-[var(--border)] p-3"
                >
                  <p className="card-title">{action.label}</p>
                  {action.detail ? (
                    <p className="meta mt-1 leading-relaxed">{action.detail}</p>
                  ) : null}
                  <Link href={action.href} className="btn btn-secondary mt-3 w-full justify-start">
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Business snapshot" description="Live workspace signals — never invented.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SnapshotCard
            title="Inbox"
            value="Open"
            body="Conversations needing reply or handoff"
            href="/inbox"
          />
          <SnapshotCard
            title="Pipeline"
            value="CRM"
            body="Deals and stages across your pipeline"
            href="/pipeline"
          />
          <SnapshotCard
            title="Opportunities"
            value={
              briefing?.phase13?.openOpportunities != null
                ? String(briefing.phase13.openOpportunities)
                : "—"
            }
            body={
              briefing?.phase13?.openOpportunities != null
                ? "Open opportunities to review"
                : "Commercial opportunities to review"
            }
            href="/opportunities"
          />
          <SnapshotCard
            title="Goals"
            value={
              briefing?.phase13?.activeGoals != null
                ? String(briefing.phase13.activeGoals)
                : "—"
            }
            body={
              briefing?.phase13?.goalsAtRisk
                ? `${briefing.phase13.goalsAtRisk} at risk`
                : "Active targets and progress"
            }
            href="/goals"
          />
        </div>
      </SectionCard>
    </PageShell>
  );
}

function SnapshotCard({
  title,
  value,
  body,
  href,
}: {
  title: string;
  value: string;
  body: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="surface-interactive block rounded-[var(--radius-card)] border border-[var(--border)] bg-white/70 p-4 transition hover:border-[var(--accent)]"
    >
      <p className="caption">{title}</p>
      <p className="metric-value mt-1 text-3xl text-[var(--foreground)]">{value}</p>
      <p className="meta mt-2 leading-relaxed">{body}</p>
    </Link>
  );
}
