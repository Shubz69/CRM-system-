"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";

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
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");

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
    const res = await fetch("/api/companies", {
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
    </div>
  );
}
