"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";
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
const FILTERS = [
  { id: "OPEN", label: "Open" },
  { id: "WON", label: "Won" },
  { id: "LOST", label: "Lost" },
  { id: "ALL", label: "All" },
] as const;

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("OPEN");

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
    const amountCents = amount.trim() === "" ? undefined : Math.round(Number(amount) * 100);
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
    setDrawerOpen(false);
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

  const filtered = useMemo(() => {
    if (filter === "ALL") return deals;
    if (filter === "LOST") return deals.filter((d) => d.status === "LOST" || d.status === "ABANDONED");
    return deals.filter((d) => d.status === filter);
  }, [deals, filter]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        description="Revenue opportunities alongside leads. Mark won or lost when the outcome is real."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-secondary" href="/pipeline">
              Pipeline
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
              + New deal
            </button>
          </div>
        }
      />

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`badge ${filter === f.id ? "badge-success" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {!loading && deals.length === 0 && (
        <EmptyState
          title="No deals yet"
          body="Create a deal when there is a real opportunity."
          actions={[
            { href: "/companies", label: "Add a company first" },
            { href: "/pipeline", label: "View pipeline" },
          ]}
        />
      )}

      {!loading && deals.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No deals in this view.</p>
      )}

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)]">
        {filtered.length > 0 ? (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Deal</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="border-b border-[var(--border)]/70 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{d.name}</p>
                    {d.stageLabel ? <p className="meta">{d.stageLabel}</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge">{statusLabel(d.status)}</span>
                  </td>
                  <td className="px-4 py-3">{formatMoney(d.amountCents, d.currency)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {d.company?.name ?? "—"}
                    {d.contact ? (
                      <>
                        {" · "}
                        <Link className="underline" href={`/contacts/${d.contact.id}`}>
                          {d.contact.fullName || d.contact.email || "Contact"}
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {STATUSES.filter((s) => s !== d.status).slice(0, 3).map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="btn btn-secondary px-2 py-1 text-xs"
                          onClick={() => void setStatus(d.id, s)}
                        >
                          {statusLabel(s)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="New deal"
        description="Name the opportunity. Amount and company are optional."
        wide
      >
        <form className="space-y-4" onSubmit={onCreate}>
          <label className="block text-sm font-medium">
            Deal name
            <input
              className="input mt-1 w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium">
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
          <label className="block text-sm font-medium">
            Stage
            <input
              className="input mt-1 w-full"
              value={stageLabel}
              onChange={(e) => setStageLabel(e.target.value)}
              placeholder="e.g. Proposal"
            />
          </label>
          <label className="block text-sm font-medium">
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
          <button className="btn btn-primary" type="submit">
            Create deal
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
