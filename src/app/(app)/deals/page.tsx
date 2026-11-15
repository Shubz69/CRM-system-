"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";
import { canWriteContacts } from "@/components/contacts/contact-permissions";
import { formatDealAmount, statusLabel } from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { useWorkspaceReady } from "@/hooks/use-workspace-ready";

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

type ContactOption = { id: string; fullName: string | null; email: string | null };

const STATUSES = ["OPEN", "WON", "LOST", "ABANDONED"] as const;
const FILTERS = [
  { id: "OPEN", label: "Open" },
  { id: "WON", label: "Won" },
  { id: "LOST", label: "Lost" },
  { id: "ALL", label: "All" },
] as const;
const FALLBACK_CURRENCIES = ["GBP", "EUR", "USD"];

function formatMoney(cents: number | null, currency: string) {
  return formatDealAmount(cents, currency);
}

/** "2500.50" → 250050; "" → null; anything else → NaN (caller rejects it). */
function parseAmount(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return Number.NaN;
  return Math.round(value * 100);
}

/** "40" → 0.4; "" → null; out of range → NaN. */
function parseProbability(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return Number.NaN;
  return Math.round(value * 10) / 1000;
}

function contactName(c: ContactOption | null) {
  if (!c) return "";
  return c.fullName || c.email || "Contact";
}

type EditState = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  stageLabel: string;
  probability: string;
  companyId: string;
  contact: ContactOption | null;
  original: Deal;
};

export default function DealsPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const workspaceReady = useWorkspaceReady();
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  // Unknown role (session still loading): show the actions; the server enforces leads:write.
  const canWrite = role ? canWriteContacts(role) : true;
  const [deals, setDeals] = useState<Deal[]>([]);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [currencies, setCurrencies] = useState<string[]>(FALLBACK_CURRENCIES);
  const [defaultCurrency, setDefaultCurrency] = useState("GBP");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [companyId, setCompanyId] = useState("");
  const [stageLabel, setStageLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("OPEN");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactOption[]>([]);

  async function load() {
    const [dRes, cRes] = await Promise.all([fetch("/api/deals"), fetch("/api/companies")]);
    const dJson = await dRes.json();
    if (!dRes.ok) throw new Error(dJson.error || "Failed to load deals");
    setDeals(dJson.deals ?? []);
    if (typeof dJson.defaultCurrency === "string") setDefaultCurrency(dJson.defaultCurrency);
    if (Array.isArray(dJson.currencies) && dJson.currencies.length) setCurrencies(dJson.currencies);
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

  const editingId = edit?.id ?? null;

  // Contact search for the edit drawer (existing org-scoped contacts API).
  useEffect(() => {
    const q = contactQuery.trim();
    if (!editingId || q.length < 2) {
      setContactResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=8`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { contacts: [] }))
        .then((json) =>
          setContactResults(
            ((json.contacts ?? []) as ContactOption[]).map((c) => ({
              id: c.id,
              fullName: c.fullName,
              email: c.email,
            })),
          ),
        )
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [contactQuery, editingId]);

  /** Currencies for a picker: the list plus whatever the deal already uses. */
  function currencyOptions(current: string) {
    return currencies.includes(current) ? currencies : [current, ...currencies];
  }

  function openCreate() {
    setCurrency(defaultCurrency);
    setDrawerOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const amountCents = parseAmount(amount);
    if (Number.isNaN(amountCents)) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        companyId: companyId || undefined,
        amountCents: amountCents ?? undefined,
        currency,
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
    setCompanyId("");
    setDrawerOpen(false);
    await load();
  }

  async function setStatus(id: string, status: (typeof STATUSES)[number]) {
    const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/deals", {
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

  function openEdit(d: Deal) {
    setContactQuery("");
    setContactResults([]);
    setEdit({
      id: d.id,
      name: d.name,
      amount: d.amountCents == null ? "" : String(d.amountCents / 100),
      currency: d.currency || defaultCurrency,
      stageLabel: d.stageLabel ?? "",
      probability: d.probability == null ? "" : String(Math.round(d.probability * 1000) / 10),
      companyId: d.company?.id ?? "",
      contact: d.contact,
      original: d,
    });
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const amountCents = parseAmount(edit.amount);
    if (Number.isNaN(amountCents)) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    const probability = parseProbability(edit.probability);
    if (Number.isNaN(probability)) {
      toast.error("Probability must be between 0 and 100");
      return;
    }
    const o = edit.original;
    // Send only what changed so the timeline records real edits.
    const patch: Record<string, unknown> = { id: edit.id };
    if (edit.name.trim() !== o.name) patch.name = edit.name.trim();
    if (amountCents !== o.amountCents) patch.amountCents = amountCents;
    if (edit.currency !== o.currency) patch.currency = edit.currency;
    if ((edit.stageLabel.trim() || null) !== (o.stageLabel ?? null)) {
      patch.stageLabel = edit.stageLabel.trim() || null;
    }
    if (probability !== o.probability) patch.probability = probability;
    if ((edit.companyId || null) !== (o.company?.id ?? null)) patch.companyId = edit.companyId || null;
    if ((edit.contact?.id ?? null) !== (o.contact?.id ?? null)) patch.contactId = edit.contact?.id ?? null;
    if (Object.keys(patch).length === 1) {
      setEdit(null);
      return;
    }
    setSaving(true);
    try {
      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/deals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Could not save the deal");
        return;
      }
      toast.success("Deal saved");
      setEdit(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(d: Deal) {
    if (!window.confirm(`Delete the deal "${d.name}"? It will disappear from deals and pipeline totals.`)) {
      return;
    }
    const res = await workspaceFetch(
      workspaceContext.loadedOrganisationId,
      workspaceContext.workspaceRevision,
      `/api/deals?id=${encodeURIComponent(d.id)}`,
      { method: "DELETE" },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error || "Could not delete the deal");
      return;
    }
    toast.success("Deal deleted");
    if (edit?.id === d.id) setEdit(null);
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
            {canWrite ? (
              <button
                type="button"
                className="btn btn-primary disabled:cursor-wait disabled:opacity-60"
                data-testid="new-deal"
                disabled={!workspaceReady}
                aria-disabled={!workspaceReady}
                onClick={openCreate}
              >
                {workspaceReady ? "+ New deal" : "Loading…"}
              </button>
            ) : null}
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
                    {d.stageLabel || d.probability != null ? (
                      <p className="meta">
                        {[
                          d.stageLabel,
                          d.probability != null ? `${Math.round(d.probability * 100)}% likely` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge">{statusLabel(d.status)}</span>
                  </td>
                  <td className="px-4 py-3">{formatMoney(d.amountCents, d.currency)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {d.company ? (
                      <Link className="underline" href={`/companies/${d.company.id}`}>
                        {d.company.name}
                      </Link>
                    ) : (
                      "—"
                    )}
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
                    {canWrite ? (
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
                        <button
                          type="button"
                          className="btn btn-secondary px-2 py-1 text-xs"
                          onClick={() => openEdit(d)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary px-2 py-1 text-xs text-[var(--danger)]"
                          onClick={() => void onDelete(d)}
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <span className="meta">View only</span>
                    )}
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
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
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
              Currency
              <select
                className="input mt-1 w-full"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                aria-label="Deal currency"
              >
                {currencyOptions(currency).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
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

      <SlideOver
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        title="Edit deal"
        description="Changes are recorded on the deal's timeline."
        wide
      >
        {edit ? (
          <form className="space-y-4" onSubmit={onSaveEdit}>
            <label className="block text-sm font-medium">
              Deal name
              <input
                className="input mt-1 w-full"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                required
                maxLength={200}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <label className="block text-sm font-medium">
                Amount
                <input
                  className="input mt-1 w-full"
                  type="number"
                  min={0}
                  step="0.01"
                  value={edit.amount}
                  onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                  placeholder="Leave blank if unknown"
                />
              </label>
              <label className="block text-sm font-medium">
                Currency
                <select
                  className="input mt-1 w-full"
                  value={edit.currency}
                  onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                  aria-label="Deal currency"
                >
                  {currencyOptions(edit.currency).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Stage
                <input
                  className="input mt-1 w-full"
                  value={edit.stageLabel}
                  onChange={(e) => setEdit({ ...edit, stageLabel: e.target.value })}
                  placeholder="e.g. Proposal"
                  maxLength={80}
                />
              </label>
              <label className="block text-sm font-medium">
                Probability (%)
                <input
                  className="input mt-1 w-full"
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  value={edit.probability}
                  onChange={(e) => setEdit({ ...edit, probability: e.target.value })}
                  placeholder="Leave blank if unknown"
                />
              </label>
            </div>
            <label className="block text-sm font-medium">
              Company
              <select
                className="input mt-1 w-full"
                value={edit.companyId}
                onChange={(e) => setEdit({ ...edit, companyId: e.target.value })}
              >
                <option value="">None</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-2 text-sm">
              <p className="font-medium">Contact</p>
              {edit.contact ? (
                <p className="flex flex-wrap items-center gap-2">
                  <span>{contactName(edit.contact)}</span>
                  <button
                    type="button"
                    className="btn btn-secondary px-2 py-1 text-xs"
                    onClick={() => setEdit({ ...edit, contact: null })}
                  >
                    Remove
                  </button>
                </p>
              ) : (
                <p className="text-[var(--muted)]">No contact linked.</p>
              )}
              <input
                className="input w-full"
                value={contactQuery}
                onChange={(e) => setContactQuery(e.target.value)}
                placeholder="Search contacts to link…"
                aria-label="Search contacts to link"
              />
              {contactResults.length > 0 ? (
                <ul className="space-y-1">
                  {contactResults.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg px-2 py-1 text-left hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          setEdit({ ...edit, contact: c });
                          setContactQuery("");
                          setContactResults([]);
                        }}
                      >
                        {contactName(c)}
                        {c.fullName && c.email ? (
                          <span className="text-[var(--muted)]"> · {c.email}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save deal"}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button
                className="btn btn-secondary ml-auto text-[var(--danger)]"
                type="button"
                onClick={() => void onDelete(edit.original)}
              >
                Delete deal
              </button>
            </div>
          </form>
        ) : null}
      </SlideOver>
    </div>
  );
}
