"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-state";
import { ANALYTICS_SUBNAV } from "@/lib/navigation";

type OutcomeSnap = {
  contacts: number | null;
  openDeals: number | null;
  opportunities: number | null;
  conversations: number | null;
  goals: number | null;
  contentPieces: number | null;
};

function Metric({
  label,
  value,
  state,
  href,
}: {
  label: string;
  value: string;
  state: string;
  href: string;
}) {
  return (
    <Link href={href} className="surface-interactive block p-4">
      <p className="caption">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">{value}</p>
      <p className="meta mt-1">{state}</p>
    </Link>
  );
}

export default function AnalyticsHubPage() {
  const [snap, setSnap] = useState<OutcomeSnap | null>(null);
  const [loading, setLoading] = useState(true);
  const items = ANALYTICS_SUBNAV.filter((i) => i.href !== "/analytics");

  useEffect(() => {
    Promise.all([
      fetch("/api/contacts").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/deals").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/opportunities").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/conversations").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/goals").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/content").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([contacts, deals, opp, conv, goals, content]) => {
        const dealList = (deals?.deals ?? []) as Array<{ status: string }>;
        setSnap({
          contacts: contacts ? (contacts.contacts ?? []).length : null,
          openDeals: deals ? dealList.filter((d) => d.status === "OPEN").length : null,
          opportunities: opp ? (opp.opportunities ?? []).length : null,
          conversations: conv
            ? (conv.conversations ?? conv.items ?? []).length
            : null,
          goals: goals ? (goals.goals ?? []).length : null,
          contentPieces: content ? (content.pieces ?? []).length : null,
        });
      })
      .catch(() => setSnap(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader description="Outcomes that matter — sales, messaging, growth, and Agent Desk contribution." />

      {loading ? (
        <PageLoading label="Loading analytics overview" />
      ) : (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="section-title">Sales</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="Contacts"
                value={snap?.contacts == null ? "—" : String(snap.contacts)}
                state={snap?.contacts == null ? "No data" : snap.contacts === 0 ? "No data yet" : "In CRM"}
                href="/contacts"
              />
              <Metric
                label="Open deals"
                value={snap?.openDeals == null ? "—" : String(snap.openDeals)}
                state={snap?.openDeals == null ? "No data" : snap.openDeals === 0 ? "No open deals" : "Active pipeline"}
                href="/deals"
              />
              <Metric
                label="Goals"
                value={snap?.goals == null ? "—" : String(snap.goals)}
                state={
                  snap?.goals == null
                    ? "No data"
                    : snap.goals === 0
                      ? "Not configured"
                      : "Goals tracked"
                }
                href="/goals"
              />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="section-title">Messaging</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Metric
                label="Conversations"
                value={snap?.conversations == null ? "—" : String(snap.conversations)}
                state={
                  snap?.conversations == null
                    ? "No data"
                    : snap.conversations === 0
                      ? "Not connected / no data yet"
                      : "Captured threads"
                }
                href="/inbox"
              />
              <Metric
                label="Opportunities"
                value={snap?.opportunities == null ? "—" : String(snap.opportunities)}
                state={
                  snap?.opportunities == null
                    ? "No data"
                    : snap.opportunities === 0
                      ? "No opportunities yet"
                      : "Open recommendations"
                }
                href="/opportunities"
              />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="section-title">Growth</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Metric
                label="Content pieces"
                value={snap?.contentPieces == null ? "—" : String(snap.contentPieces)}
                state={
                  snap?.contentPieces == null
                    ? "No data"
                    : snap.contentPieces === 0
                      ? "No content yet"
                      : "In workspace"
                }
                href="/content"
              />
              <Link href="/learning" className="surface-insight block p-4">
                <p className="caption">Learning</p>
                <p className="mt-1 font-medium">Business patterns</p>
                <p className="meta mt-1">What is changing, what works, what needs more data</p>
              </Link>
            </div>
          </section>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="surface-interactive flex items-start gap-3 p-5 transition hover:border-[var(--accent)]"
            >
              <span className="rounded-xl bg-[var(--surface-2)] p-2.5 text-[var(--foreground)]">
                <Icon size={18} />
              </span>
              <span>
                <span className="block font-medium text-[var(--foreground)]">{item.label}</span>
                <span className="mt-1 block text-sm text-[var(--muted)]">
                  {analyticsHint(item.href)}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function analyticsHint(href: string): string {
  switch (href) {
    case "/reports":
      return "Daily and weekly results from live workspace data.";
    case "/insights":
      return "Patterns across conversations and performance.";
    case "/learning":
      return "Business learning — not engineering evals.";
    default:
      return "Open analytics.";
  }
}
