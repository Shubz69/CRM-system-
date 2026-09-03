"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { profileStateLabel, profileStateTone } from "@/lib/customer-labels";

type CompletenessItem = {
  key: string;
  label: string;
  status: string;
  detail: string;
};

type Profile = {
  organisation: { id: string; name: string; slug: string } | null;
  products: Array<{ id: string; name: string }>;
  audiences: Array<{ id: string; name: string }>;
  competitors: Array<{ id: string; sourceId: string; targetId: string }>;
  goals: Array<{ id: string; name: string; status: string }>;
  kpis: Array<{ id: string; name: string }>;
  initiatives: Array<{ id: string; name: string }>;
  freshness: Record<string, string>;
  atRisk: Array<{ id: string; name: string }>;
};

const SECTION_ORDER = [
  "business",
  "products",
  "audience",
  "markets",
  "brand",
  "sales",
  "goals",
  "policies",
  "competitors",
  "social",
  "knowledge_health",
] as const;

function StateBadge({ status }: { status: string }) {
  const label = profileStateLabel(status);
  const tone = profileStateTone(status);
  const className =
    tone === "success"
      ? "badge badge-success"
      : tone === "warn"
        ? "badge badge-warn"
        : "badge";
  return <span className={className}>{label}</span>;
}

export default function BusinessContextPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [completeness, setCompleteness] = useState<CompletenessItem[]>([]);
  const [productName, setProductName] = useState("");
  const [audienceName, setAudienceName] = useState("");
  const [marketRegion, setMarketRegion] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/business-context");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load business profile");
    setProfile(json.profile);
    setCompleteness(json.completeness ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  const byKey = useMemo(() => {
    const map = new Map(completeness.map((item) => [item.key, item]));
    return map;
  }, [completeness]);

  const ordered = SECTION_ORDER.map((key) => byKey.get(key)).filter(
    (item): item is CompletenessItem => Boolean(item),
  );
  const extras = completeness.filter(
    (item) => !(SECTION_ORDER as readonly string[]).includes(item.key),
  );

  const confirmed = completeness.filter((i) => profileStateLabel(i.status) === "Confirmed").length;
  const needsReview = completeness.filter(
    (i) => profileStateLabel(i.status) === "Needs review",
  ).length;
  const missing = completeness.filter((i) => profileStateLabel(i.status) === "Missing").length;
  const totalAreas = Math.max(completeness.length, 1);
  const completePct = Math.round((confirmed / totalAreas) * 100);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader description="What Agent Desk knows about your business — confirmed, needs review, or missing." />

      <section className="surface-primary p-5 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="caption">Business Profile</p>
            <p className="mt-1 font-[family-name:var(--font-fraunces)] text-4xl tracking-tight">
              {completePct}% complete
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Agent Desk understands {confirmed} of {totalAreas} important areas
              {profile?.organisation?.name ? ` for ${profile.organisation.name}` : ""}.
            </p>
          </div>
          <a href="#profile-checklist" className="btn btn-primary">
            Complete profile
          </a>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <span className="badge badge-success">{confirmed} confirmed</span>
          <span className="badge badge-warn">{needsReview} need review</span>
          <span className="badge">{missing} missing</span>
        </div>
      </section>

      <section id="profile-checklist" className="space-y-2">
        <h2 className="section-title">Profile checklist</h2>
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)]">
          {[...ordered, ...extras].map((item) => {
            const open = openKey === item.key;
            const done = profileStateLabel(item.status) === "Confirmed";
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-2)]"
                  onClick={() => setOpenKey(open ? null : item.key)}
                  aria-expanded={open}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                      done
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border border-[var(--border)] text-[var(--muted)]"
                    }`}
                    aria-hidden
                  >
                    {done ? "✓" : "○"}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{item.label}</span>
                  <StateBadge status={item.status} />
                </button>
                {open ? (
                  <div className="border-t border-[var(--border)]/70 bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--muted)]">
                    <p>{item.detail}</p>
                    {item.key === "products" ? (
                      <form
                        className="mt-3 flex flex-wrap gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!productName.trim()) return;
                          const res = await fetch("/api/business-context", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "create_product", name: productName }),
                          });
                          if (!res.ok) {
                            toast.error("Could not add product");
                            return;
                          }
                          setProductName("");
                          toast.success("Product added");
                          await load();
                        }}
                      >
                        <input
                          className="input flex-1"
                          placeholder="Add a product or service"
                          value={productName}
                          onChange={(e) => setProductName(e.target.value)}
                        />
                        <button className="btn btn-secondary" type="submit">
                          Add
                        </button>
                      </form>
                    ) : item.key === "audience" ? (
                      <form
                        className="mt-3 flex flex-wrap gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!audienceName.trim()) return;
                          const res = await fetch("/api/business-context", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "create_audience",
                              name: audienceName.trim(),
                            }),
                          });
                          if (!res.ok) {
                            toast.error("Could not add audience");
                            return;
                          }
                          setAudienceName("");
                          toast.success("Audience added");
                          await load();
                        }}
                      >
                        <input
                          className="input flex-1"
                          placeholder="Add a customer / audience segment"
                          value={audienceName}
                          onChange={(e) => setAudienceName(e.target.value)}
                        />
                        <button className="btn btn-secondary" type="submit">
                          Add
                        </button>
                      </form>
                    ) : item.key === "markets" ? (
                      <form
                        className="mt-3 flex flex-wrap gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!marketRegion.trim()) return;
                          const subjectId = profile?.organisation?.id;
                          if (!subjectId) {
                            toast.error("Workspace profile not loaded yet");
                            return;
                          }
                          const res = await fetch("/api/business-context", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "upsert_claim",
                              subjectType: "Organisation",
                              subjectId,
                              predicate: "operates_in_market",
                              valueText: marketRegion.trim(),
                              source: "business_profile_checklist",
                            }),
                          });
                          if (!res.ok) {
                            toast.error("Could not add market / region");
                            return;
                          }
                          setMarketRegion("");
                          toast.success("Market / region added");
                          await load();
                        }}
                      >
                        <input
                          className="input flex-1"
                          placeholder="e.g. UK, US East Coast, DACH"
                          value={marketRegion}
                          onChange={(e) => setMarketRegion(e.target.value)}
                        />
                        <button className="btn btn-secondary" type="submit">
                          Add
                        </button>
                      </form>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link href="/settings" className="btn btn-secondary">
                          Edit in Settings
                        </Link>
                        <Link href="/knowledge" className="btn btn-secondary">
                          Add to Knowledge
                        </Link>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
          {completeness.length === 0 && (
            <li className="px-4 py-4 text-sm text-[var(--muted)]">Loading profile…</li>
          )}
        </ul>
      </section>

      {profile && (profile.products.length > 0 || profile.audiences.length > 0) ? (
        <section className="surface-muted p-4 text-sm">
          <p className="caption">At a glance</p>
          <p className="mt-2 text-[var(--muted)]">
            {[
              profile.products.length
                ? `Products: ${profile.products.map((p) => p.name).join(", ")}`
                : null,
              profile.audiences.length
                ? `Audiences: ${profile.audiences.map((a) => a.name).join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </section>
      ) : null}
    </div>
  );
}
