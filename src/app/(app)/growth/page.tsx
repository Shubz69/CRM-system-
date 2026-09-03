"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";
import { GROWTH_SUBNAV } from "@/lib/navigation";

type GrowthSnap = {
  opportunities: number;
  goals: number;
  research: number;
};

export default function GrowthHubPage() {
  const [snap, setSnap] = useState<GrowthSnap | null>(null);
  const [loading, setLoading] = useState(true);
  const items = GROWTH_SUBNAV.filter((i) => i.href !== "/growth");

  useEffect(() => {
    Promise.all([
      fetch("/api/opportunities").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/goals").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/research").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([opp, goals, research]) => {
        setSnap({
          opportunities: (opp?.opportunities ?? []).length,
          goals: (goals?.goals ?? []).length,
          research: (research?.jobs ?? []).length,
        });
      })
      .catch(() => setSnap(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageShell>
      <PageHeader description="Where Agent Desk helps you find and create more business." />

      {loading ? (
        <PageLoading label="Loading growth overview" />
      ) : snap ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Link href="/opportunities" className="surface surface-interactive p-4">
            <p className="caption">Opportunities</p>
            <p className="metric-value mt-1 text-3xl">{snap.opportunities}</p>
            <p className="meta mt-1">Open recommendations</p>
          </Link>
          <Link href="/research" className="surface surface-interactive p-4">
            <p className="caption">Research</p>
            <p className="metric-value mt-1 text-3xl">{snap.research}</p>
            <p className="meta mt-1">Topics & briefs</p>
          </Link>
          <Link href="/goals" className="surface surface-interactive p-4">
            <p className="caption">Goals</p>
            <p className="metric-value mt-1 text-3xl">{snap.goals}</p>
            <p className="meta mt-1">Goals tracked</p>
          </Link>
          <Link href="/growth/prospecting" className="surface surface-interactive p-4 sm:col-span-3">
            <p className="caption">Social prospecting</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Who would you like Agent Desk to find? Research-backed prospects with LinkedIn Open/Copy
              outreach (V1).
            </p>
          </Link>
        </div>
      ) : null}

      {!loading && snap && snap.opportunities === 0 && snap.goals === 0 && snap.research === 0 ? (
        <div className="surface-insight max-w-2xl p-5">
          <p className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
            Where can you grow?
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Growth watches opportunities, research, content, and goals. Complete your business
            profile, then run a scan or start research so Agent Desk has something to monitor.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/business-context" className="btn btn-primary">
              Complete profile
            </Link>
            <Link href="/opportunities" className="btn btn-secondary">
              Scan opportunities
            </Link>
            <Link href="/goals" className="btn btn-secondary">
              Set a goal
            </Link>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="surface surface-interactive flex items-start gap-3 p-5"
            >
              <span className="rounded-xl bg-[var(--surface-2)] p-2.5 text-[var(--foreground)]">
                <Icon size={18} />
              </span>
              <span>
                <span className="card-title block">{item.label}</span>
                <span className="meta mt-1 block leading-relaxed">{growthHint(item.href)}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </PageShell>
  );
}

function growthHint(href: string): string {
  switch (href) {
    case "/growth/prospecting":
      return "Research-backed prospects and manual LinkedIn/Instagram outreach.";
    case "/opportunities":
      return "Commercial moves Agent Desk recommends you review.";
    case "/research":
      return "Sourced briefs on markets, competitors, and topics.";
    case "/business-context":
      return "Who you are, what you sell, and how you win.";
    case "/knowledge":
      return "Brand facts and answers the AI can trust.";
    case "/content":
      return "Pieces, drafts, and publish readiness.";
    case "/goals":
      return "Targets, KPIs, and progress.";
    case "/social-intelligence":
      return "Trends and signals from social listening.";
    default:
      return "Open this growth area.";
  }
}
