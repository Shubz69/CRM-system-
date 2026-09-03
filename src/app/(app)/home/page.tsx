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

type Snapshot = {
  needsReply: number | null;
  needingHuman: number | null;
  activeLeads: number | null;
  openDeals: number | null;
  opportunities: number | null;
  goalsConfigured: boolean;
  goalsAtRisk: number;
};

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const router = useRouter();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    needsReply: null,
    needingHuman: null,
    activeLeads: null,
    openDeals: null,
    opportunities: null,
    goalsConfigured: false,
    goalsAtRisk: 0,
  });
  const [askDraft, setAskDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [briefRes, convRes, dealsRes, contactsRes, oppsRes, goalsRes] =
          await Promise.all([
            fetch("/api/chief-of-staff"),
            fetch("/api/conversations"),
            fetch("/api/deals"),
            fetch("/api/contacts"),
            fetch("/api/opportunities"),
            fetch("/api/goals"),
          ]);
        const briefJson = briefRes.ok ? await briefRes.json() : null;
        if (!cancelled && briefJson) setBriefing(briefJson as Briefing);

        let needsReply: number | null = null;
        let needingHuman: number | null = null;
        if (convRes.ok) {
          const cJson = await convRes.json();
          const items = (cJson.conversations ?? cJson.items ?? []) as Array<{
            unreadCount?: number;
            needsHumanReview?: boolean;
            handlingMode?: string;
          }>;
          needingHuman = items.filter(
            (c) => c.needsHumanReview || c.handlingMode === "HUMAN",
          ).length;
          // Broader: unread OR handoff — intentionally can exceed "needing human".
          needsReply = items.filter(
            (c) => (c.unreadCount ?? 0) > 0 || c.needsHumanReview,
          ).length;
        }

        let openDeals: number | null = null;
        if (dealsRes.ok) {
          const dJson = await dealsRes.json();
          const deals = (dJson.deals ?? []) as Array<{ status: string }>;
          openDeals = deals.filter((d) => d.status === "OPEN").length;
        }

        let activeLeads: number | null = null;
        if (contactsRes.ok) {
          const contactsJson = await contactsRes.json();
          activeLeads = (contactsJson.contacts ?? []).length;
        }

        let opportunities: number | null = null;
        if (oppsRes.ok) {
          const oJson = await oppsRes.json();
          const list = (oJson.opportunities ?? oJson.items ?? []) as Array<{
            status?: string;
          }>;
          opportunities = list.filter((o) =>
            ["DETECTED", "REVIEWED", "ACCEPTED", "IN_PROGRESS"].includes(
              o.status ?? "",
            ),
          ).length;
        }

        let goalsConfigured = false;
        let goalsAtRisk = 0;
        if (goalsRes.ok) {
          const gJson = await goalsRes.json();
          const goals = (gJson.goals ?? []) as Array<{ status?: string }>;
          goalsConfigured = goals.some((g) =>
            ["ACTIVE", "AT_RISK"].includes(g.status ?? ""),
          );
          goalsAtRisk = goals.filter((g) => g.status === "AT_RISK").length;
        }

        if (!cancelled) {
          setSnapshot({
            needsReply,
            needingHuman,
            activeLeads,
            openDeals,
            opportunities,
            goalsConfigured,
            goalsAtRisk,
          });
        }
      } catch {
        /* keep empty */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
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
  const isEmptyDesk =
    (snapshot.needsReply ?? 0) === 0 &&
    (snapshot.activeLeads ?? 0) === 0 &&
    (snapshot.openDeals ?? 0) === 0 &&
    !setupNeeded;
  const statusLine = setupNeeded
    ? "A few setup steps will unlock the full desk — start with your business profile or social accounts."
    : attention.length > 0
      ? `${attention.length} item${attention.length === 1 ? "" : "s"} need your attention.`
      : isEmptyDesk
        ? "Your workspace is ready. Pick a first action below."
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
          <p className="section-title">Get started</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Tell Agent Desk about your business, then connect social accounts when you&apos;re ready.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/onboarding" className="btn btn-primary">
              Short onboarding
            </Link>
            <Link href="/business-context" className="btn btn-secondary">
              Business profile
            </Link>
            <Link href="/integrations" className="btn btn-secondary">
              Social accounts
            </Link>
          </div>
        </div>
      ) : isEmptyDesk ? (
        <div className="surface p-5 md:p-6">
          <p className="section-title">First actions</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Start with a question, draft content, or find prospects — no provider setup required.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/ask" className="btn btn-primary">
              Ask Agent Desk
            </Link>
            <Link href="/content" className="btn btn-secondary">
              Draft content
            </Link>
            <Link href="/growth/prospecting" className="btn btn-secondary">
              Find prospects
            </Link>
            <Link href="/inbox" className="btn btn-secondary">
              Open inbox
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

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
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
            <ul className="divide-y divide-[var(--border)]/70">
              {attention.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="block px-1 py-3 transition hover:bg-[var(--surface-2)]"
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

        <SectionCard title="Recommended next moves">
          {actions.length === 0 ? (
            <EmptyState
              title="Start with the essentials"
              body="Your workspace is ready. Pick a next step — no setup jargon required."
              actions={[
                { href: "/ask", label: "Ask Agent Desk", primary: true },
                { href: "/growth/prospecting", label: "Find prospects" },
                { href: "/integrations", label: "Connect social" },
                { href: "/knowledge", label: "Add knowledge" },
                { href: "/contacts", label: "Open CRM" },
              ]}
            />
          ) : (
            <ul className="divide-y divide-[var(--border)]/70">
              {actions.slice(0, 5).map((action) => (
                <li key={`${action.href}-${action.label}`} className="py-3 first:pt-0 last:pb-0">
                  <p className="card-title">{action.label}</p>
                  {action.detail ? (
                    <p className="meta mt-1 leading-relaxed">
                      <span className="font-medium text-[var(--foreground)]/70">Why: </span>
                      {action.detail}
                    </p>
                  ) : null}
                  <Link href={action.href} className="btn btn-secondary mt-2">
                    {action.label.startsWith("Finish") || action.label.startsWith("Define")
                      ? "Continue"
                      : "Next"}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Business snapshot"
        description="Honest counts — ‘needing human’ is handoffs only; ‘needing reply’ also includes unread threads."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SnapshotCard
            title="Needing a human"
            value={snapshot.needingHuman == null ? "—" : String(snapshot.needingHuman)}
            body={
              snapshot.needingHuman == null
                ? "No data yet"
                : "Handoff / human handling only"
            }
            href="/inbox?queue=human"
          />
          <SnapshotCard
            title="Needing reply"
            value={snapshot.needsReply == null ? "—" : String(snapshot.needsReply)}
            body={
              snapshot.needsReply == null
                ? "No data yet"
                : "Unread or needing human review"
            }
            href="/inbox"
          />
          <SnapshotCard
            title="Contacts"
            value={snapshot.activeLeads == null ? "—" : String(snapshot.activeLeads)}
            body={
              snapshot.activeLeads == null
                ? "No data yet"
                : snapshot.activeLeads === 0
                  ? "No contacts yet"
                  : "People in your CRM"
            }
            href="/contacts"
          />
          <SnapshotCard
            title="Open deals"
            value={snapshot.openDeals == null ? "—" : String(snapshot.openDeals)}
            body={snapshot.openDeals == null ? "No data yet" : "Deals still open"}
            href="/deals"
          />
          <SnapshotCard
            title="Opportunities"
            value={
              snapshot.opportunities == null ? "—" : String(snapshot.opportunities)
            }
            body={
              snapshot.opportunities == null
                ? "No data yet"
                : "Open opportunities to review"
            }
            href="/opportunities"
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SnapshotCard
            title="Goal progress"
            value={
              !snapshot.goalsConfigured
                ? "Not configured"
                : snapshot.goalsAtRisk > 0
                  ? `${snapshot.goalsAtRisk} at risk`
                  : "On track"
            }
            body={
              !snapshot.goalsConfigured
                ? "Set a sales goal to prioritise growth"
                : "Active targets"
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
