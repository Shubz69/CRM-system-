"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Attribution = {
  id: string;
  source: string | null;
  medium: string | null;
  confidence: number | null;
  limitations: string | null;
  method?: string | null;
  campaign?: { name: string } | null;
};

type Deal = {
  id: string;
  name: string;
  status: string;
  amountCents: number | null;
  currency: string;
  stageLabel: string | null;
  probability: number | null;
};

type Activity = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  createdAt: string;
};

type Company = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
} | null;

type Customer360 = {
  company: Company;
  deals: Deal[];
  activities: Activity[];
  attributions: Attribution[];
  limitations: string[];
};

function formatMoney(cents: number | null, currency: string) {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * Evidence-based Customer 360 — only stored CRM rows; shows attribution confidence/limitations honestly.
 */
export function Customer360Panel({ contactId }: { contactId: string }) {
  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/contacts/${contactId}/360`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed to load 360");
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (loading) {
    return (
      <section className="surface p-5">
        <h2 className="font-semibold">Customer 360</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">Loading stored CRM evidence…</p>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="surface p-5">
        <h2 className="font-semibold">Customer 360</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">{error || "Unavailable"}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-[family-name:var(--font-fraunces)] text-xl">Customer 360</h2>
        <Link href="/deals" className="text-xs text-[var(--muted)] underline">
          All deals
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <article className="surface p-4">
          <h3 className="text-sm font-semibold">Company</h3>
          {data.company ? (
            <div className="mt-2 space-y-1 text-sm">
              <p className="font-medium">{data.company.name}</p>
              <p className="text-[var(--muted)]">
                {[data.company.domain, data.company.industry].filter(Boolean).join(" · ") || "—"}
              </p>
              <Link
                href="/companies"
                className="inline-block text-xs text-[var(--accent)] underline"
              >
                Companies
              </Link>
            </div>
          ) : (
            <p className="mt-2 text-sm text-[var(--muted)]">No company linked.</p>
          )}
        </article>

        <article className="surface p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold">Deals</h3>
          {data.deals.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--muted)]">No deals for this contact.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {data.deals.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-sm"
                >
                  <span className="badge">{d.status}</span>
                  <span className="font-medium">{d.name}</span>
                  <span className="text-[var(--muted)]">
                    {formatMoney(d.amountCents, d.currency)}
                    {d.stageLabel ? ` · ${d.stageLabel}` : ""}
                    {d.probability != null ? ` · ${Math.round(d.probability * 100)}%` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <article className="surface p-4">
        <h3 className="text-sm font-semibold">Attribution (with confidence)</h3>
        {data.attributions.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">No attribution rows stored.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {data.attributions.map((a) => (
              <li key={a.id} className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                <p>
                  {a.source || "Unknown"} · {a.medium || "—"}
                  {a.campaign?.name ? ` · ${a.campaign.name}` : ""}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Confidence:{" "}
                  {a.confidence == null ? "unknown" : `${Math.round(a.confidence * 100)}%`}
                  {a.method ? ` · ${a.method}` : ""}
                </p>
                {a.limitations ? (
                  <p className="mt-1 text-xs text-[var(--muted)]">Limitations: {a.limitations}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="surface p-4">
        <h3 className="text-sm font-semibold">Recent CRM activity</h3>
        {data.activities.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">No CrmActivity rows yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {data.activities.slice(0, 8).map((a) => (
              <li key={a.id} className="rounded-xl bg-[var(--surface-2)] px-3 py-2">
                <span className="badge mr-2">{a.kind}</span>
                {a.title || a.body || "Activity"}
                <span className="ml-2 text-xs text-[var(--muted)]">
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>

      {data.limitations.length > 0 && (
        <ul className="space-y-1 text-xs text-[var(--muted)]">
          {data.limitations.map((l) => (
            <li key={l}>· {l}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
