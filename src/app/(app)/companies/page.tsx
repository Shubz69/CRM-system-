"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type Company = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeBand: string | null;
  updatedAt: string;
  _count: { contacts: number; deals: number };
};

export default function CompaniesPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<{
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
    contacts: Array<{ id: string; fullName: string | null; email: string | null }>;
    deals: Array<{ id: string; name: string; status: string; amountCents: number | null }>;
    _count: { contacts: number; deals: number };
  } | null>(null);

  async function load() {
    const res = await fetch("/api/companies");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load companies");
    setCompanies(json.companies ?? []);
  }

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        domain: domain || undefined,
        industry: industry || undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Create failed");
      return;
    }
    toast.success("Company saved");
    setName("");
    setDomain("");
    setIndustry("");
    setDrawerOpen(false);
    await load();
  }

  const filtered = companies.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.domain, c.industry].filter(Boolean).join(" ").toLowerCase().includes(q);
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        description="Accounts linked to contacts and deals."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-secondary" href="/deals">
              Deals
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
              + Add company
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input max-w-sm flex-1"
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search companies"
        />
      </div>

      {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {!loading && companies.length === 0 && (
        <div className="space-y-3">
          <EmptyState
            title="No companies yet"
            body="Add an account when you know the business behind a contact."
            actions={[{ href: "/contacts", label: "Browse contacts" }]}
          />
          <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
            + Add company
          </button>
        </div>
      )}

      {!loading && companies.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No companies match your search.</p>
      )}

      <div className="grid gap-2">
        {filtered.map((c) => (
          <article
            key={c.id}
            className="surface-interactive flex flex-wrap items-center gap-3 px-4 py-3"
            role="button"
            tabIndex={0}
            onClick={async () => {
              try {
                const res = await fetch(`/api/companies/${c.id}`);
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Could not load company");
                setDetail(json.company);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                (e.currentTarget as HTMLElement).click();
              }
            }}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.name}</p>
              <p className="text-sm text-[var(--muted)]">
                {[c.domain, c.industry, c.sizeBand].filter(Boolean).join(" · ") || "No extras"}
              </p>
            </div>
            <span className="badge">{c._count.contacts} contacts</span>
            <span className="badge">{c._count.deals} deals</span>
          </article>
        ))}
      </div>

      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add company"
        description="Name is required. Domain and industry help Agent Desk recognise the account."
      >
        <form className="space-y-4" onSubmit={onCreate}>
          <label className="block text-sm font-medium">
            Name
            <input
              className="input mt-1 w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium">
            Domain
            <input
              className="input mt-1 w-full"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
          </label>
          <label className="block text-sm font-medium">
            Industry
            <input
              className="input mt-1 w-full"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </label>
          <button className="btn btn-primary" type="submit">
            Save company
          </button>
        </form>
      </SlideOver>

      <SlideOver
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name || "Company"}
        description="Contacts and deals linked to this account."
      >
        {detail ? (
          <div className="space-y-4 text-sm">
            <p className="text-[var(--muted)]">
              {[detail.domain, detail.industry].filter(Boolean).join(" · ") || "No extra company details"}
            </p>
            <div>
              <p className="font-medium">Contacts ({detail._count.contacts})</p>
              {detail.contacts.length === 0 ? (
                <p className="mt-1 text-[var(--muted)]">None yet.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {detail.contacts.map((p) => (
                    <li key={p.id}>
                      <Link className="underline" href={`/contacts/${p.id}`}>
                        {p.fullName || "Unnamed"}
                      </Link>
                      {p.email ? ` · ${p.email}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="font-medium">Deals ({detail._count.deals})</p>
              {detail.deals.length === 0 ? (
                <p className="mt-1 text-[var(--muted)]">None yet.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {detail.deals.map((d) => (
                    <li key={d.id}>
                      <Link className="underline" href="/deals">
                        {d.name}
                      </Link>{" "}
                      · {d.status}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Link className="btn btn-secondary" href="/contacts">
              Add a contact
            </Link>
          </div>
        ) : null}
      </SlideOver>
    </div>
  );
}
