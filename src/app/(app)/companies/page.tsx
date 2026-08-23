"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

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
    await load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        description="Accounts linked to contacts and deals. Stored CRM data only — not inferred firmographics."
        actions={
          <Link className="btn btn-secondary" href="/deals">
            Deals
          </Link>
        }
      />

      <form className="surface grid gap-3 p-4 md:grid-cols-4" onSubmit={onCreate}>
        <label className="text-sm font-medium md:col-span-2">
          Name
          <input
            className="input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-sm font-medium">
          Domain
          <input
            className="input mt-1 w-full"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
          />
        </label>
        <label className="text-sm font-medium">
          Industry
          <input
            className="input mt-1 w-full"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
        </label>
        <button className="btn btn-primary md:col-span-4 w-fit" type="submit">
          Add company
        </button>
      </form>

      {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {!loading && companies.length === 0 && (
        <EmptyState
          title="No companies yet"
          body="Add an account when you know the business behind a contact. Link deals from the Deals page."
          actionHref="/contacts"
          actionLabel="Browse contacts"
        />
      )}

      <div className="grid gap-3">
        {companies.map((c) => (
          <article key={c.id} className="surface flex flex-wrap items-center gap-3 p-4">
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
    </div>
  );
}
