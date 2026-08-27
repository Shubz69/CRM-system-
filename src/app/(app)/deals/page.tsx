"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { statusLabel } from "@/lib/customer-labels";

type Deal = {
  id: string;
  name: string;
  status: string;
  amountCents: number | null;
  currency: string;
  probability: number | null;
  stageLabel: string | null;
  summary: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; fullName: string | null; email: string | null } | null;
  updatedAt: string;
};

const STATUSES = ["OPEN", "WON", "LOST", "ABANDONED"] as const;

function formatMoney(cents: number | null, currency: string) {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [stageLabel, setStageLabel] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    const [dRes, cRes] = await Promise.all([fetch("/api/deals"), fetch("/api/companies")]);
    const dJson = await dRes.json();
    if (!dRes.ok) throw new Error(dJson.error || "Failed to load deals");
    setDeals(dJson.deals ?? []);
    if (cRes.ok) {
      const cJson = await cRes.json();
      setCompanies(
        (cJson.companies ?? []).map((c: { id: string; name: string }) => ({
          id: c.id,
          name: c.name,
        })),
      );
    }
  }

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const amountCents =
      amount.trim() === "" ? undefined : Math.round(Number(amount) * 100);
    if (amount.trim() && (Number.isNaN(amountCents!) || amountCents! < 0)) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    const res = await fetch("/api/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        companyId: companyId || undefined,
        amountCents,
        stageLabel: stageLabel || undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Create failed");
      return;
    }
    toast.success("Deal created");
    setName("");
    setAmount("");
    setStageLabel("");
    await load();
  }

  async function setStatus(id: string, status: (typeof STATUSES)[number]) {
    const res = await fetch("/api/deals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Update failed");
      return;
    }
    toast.success(`Marked ${statusLabel(status)}`);
    await load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        description="Revenue opportunities alongside leads. Mark won or lost when the outcome is real."
        actions={
          <>
            <Link className="btn btn-secondary" href="/companies">
              Companies
            </Link>
            <Link className="btn btn-secondary" href="/pipeline">
              Lead pipeline
            </Link>
          </>
        }
      />

      <form className="surface grid gap-3 p-4 md:grid-cols-4" onSubmit={onCreate}>
        <label className="text-sm font-medium md:col-span-2">
          Deal name
          <input
            className="input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-sm font-medium">
          Amount
          <input
            className="input mt-1 w-full"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 2500"
          />
        </label>
        <label className="text-sm font-medium">
          Stage label
          <input
            className="input mt-1 w-full"
            value={stageLabel}
            onChange={(e) => setStageLabel(e.target.value)}
            placeholder="e.g. Proposal"
          />
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Company
          <select
            className="input mt-1 w-full"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">None</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary self-end" type="submit">
          Create deal
        </button>
      </form>

      {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {!loading && deals.length === 0 && (
        <EmptyState
          title="No deals yet"
          body="Create a deal when there is a real opportunity. Lead pipeline remains for Instagram qualification."
          actionHref="/companies"
          actionLabel="Add a company first"
        />
      )}

      <div className="grid gap-3">
        {deals.map((d) => (
          <article key={d.id} className="surface space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{statusLabel(d.status)}</span>
              <p className="font-medium">{d.name}</p>
              <span className="text-sm text-[var(--muted)]">
                {formatMoney(d.amountCents, d.currency)}
              </span>
              {d.stageLabel && <span className="badge">{d.stageLabel}</span>}
            </div>
            <p className="text-sm text-[var(--muted)]">
              {d.company ? (
                <>Company: {d.company.name}</>
              ) : (
                "No company"
              )}
              {d.contact ? (
                <>
                  {" · "}
                  <Link className="underline" href={`/contacts/${d.contact.id}`}>
                    {d.contact.fullName || d.contact.email || "Contact"}
                  </Link>
                </>
              ) : null}
            </p>
            {d.summary && <p className="text-sm">{d.summary}</p>}
            <div className="flex flex-wrap gap-2">
              {STATUSES.filter((s) => s !== d.status).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn btn-secondary text-xs"
                  onClick={() => void setStatus(d.id, s)}
                >
                  Mark {statusLabel(s)}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
