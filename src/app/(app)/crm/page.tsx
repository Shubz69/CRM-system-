"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";
import { CRM_SUBNAV } from "@/lib/navigation";

type Snapshot = {
  contacts: number;
  companies: number;
  openDeals: number;
  dealValueCents: number;
  stages: number;
};

export default function CrmHubPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const items = CRM_SUBNAV.filter((i) => i.href !== "/crm");

  useEffect(() => {
    Promise.all([
      fetch("/api/contacts").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/companies").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/deals").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/pipeline").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([contacts, companies, deals, pipeline]) => {
        const dealList = (deals?.deals ?? []) as Array<{
          status: string;
          amountCents: number | null;
        }>;
        const open = dealList.filter((d) => d.status === "OPEN");
        setSnap({
          contacts: (contacts?.contacts ?? []).length,
          companies: (companies?.companies ?? []).length,
          openDeals: open.length,
          dealValueCents: open.reduce((n, d) => n + (d.amountCents ?? 0), 0),
          stages: (pipeline?.pipeline?.stages ?? []).length,
        });
      })
      .catch(() => setSnap(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageShell>
      <PageHeader description="Contacts, companies, deals, and pipeline — one customer view." />

      {loading ? (
        <PageLoading label="Loading CRM overview" />
      ) : snap ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric title="Contacts" value={String(snap.contacts)} href="/contacts" />
          <Metric title="Companies" value={String(snap.companies)} href="/companies" />
          <Metric title="Open deals" value={String(snap.openDeals)} href="/deals" />
          <Metric
            title="Open pipeline"
            value={
              snap.dealValueCents > 0
                ? `£${(snap.dealValueCents / 100).toLocaleString()}`
                : String(snap.stages || "—")
            }
            body={snap.dealValueCents > 0 ? "Sum of open deal amounts" : "Pipeline stages configured"}
            href="/pipeline"
          />
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
                <span className="meta mt-1 block leading-relaxed">{crmHint(item.href)}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </PageShell>
  );
}

function Metric({
  title,
  value,
  body,
  href,
}: {
  title: string;
  value: string;
  body?: string;
  href: string;
}) {
  return (
    <Link href={href} className="surface surface-interactive block p-4">
      <p className="caption">{title}</p>
      <p className="metric-value mt-1 text-3xl">{value}</p>
      {body ? <p className="meta mt-1">{body}</p> : null}
    </Link>
  );
}

function crmHint(href: string): string {
  switch (href) {
    case "/contacts":
      return "People you talk to — messages, qualification, and history.";
    case "/companies":
      return "Accounts and organisations linked to your deals.";
    case "/deals":
      return "Commercial opportunities with value and stage.";
    case "/pipeline":
      return "Board view of leads moving toward revenue.";
    default:
      return "Open this area of CRM.";
  }
}
