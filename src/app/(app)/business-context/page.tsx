"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type CompletenessItem = {
  key: string;
  label: string;
  status: string;
  detail: string;
};

type Profile = {
  organisation: { name: string; slug: string } | null;
  products: Array<{ id: string; name: string }>;
  audiences: Array<{ id: string; name: string }>;
  competitors: Array<{ id: string; sourceId: string; targetId: string }>;
  goals: Array<{ id: string; name: string; status: string }>;
  kpis: Array<{ id: string; name: string }>;
  initiatives: Array<{ id: string; name: string }>;
  freshness: Record<string, string>;
  atRisk: Array<{ id: string; name: string }>;
};

export default function BusinessContextPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [completeness, setCompleteness] = useState<CompletenessItem[]>([]);
  const [productName, setProductName] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/business-context");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load business context");
    setProfile(json.profile);
    setCompleteness(json.completeness ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  return (
    <div className="space-y-8">
      <PageHeader description="Evidence-backed business context — missing data is shown honestly." />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Context completeness</h2>
        <ul className="space-y-2">
          {completeness.map((item) => (
            <li key={item.key} className="text-sm flex flex-wrap gap-2">
              <span className="font-medium min-w-[10rem]">{item.label}</span>
              <span className="uppercase text-xs tracking-wide">{item.status}</span>
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Known information</h2>
        {!profile ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              <strong>Organisation:</strong> {profile.organisation?.name ?? "Unknown"}
              {profile.freshness?.organisation
                ? ` · freshness ${profile.freshness.organisation}`
                : ""}
            </p>
            <p>
              <strong>Products:</strong>{" "}
              {profile.products.length
                ? profile.products.map((p) => p.name).join(", ")
                : "Insufficient data"}
            </p>
            <p>
              <strong>Audiences:</strong>{" "}
              {profile.audiences.length
                ? profile.audiences.map((a) => a.name).join(", ")
                : "Insufficient data"}
            </p>
            <p>
              <strong>Competitor relations:</strong> {profile.competitors.length || "None configured"}
            </p>
            <p>
              <strong>Active goals:</strong>{" "}
              {profile.goals.length
                ? profile.goals.map((g) => `${g.name} (${g.status})`).join(", ")
                : "None"}
            </p>
            <p>
              <strong>KPIs:</strong>{" "}
              {profile.kpis.length ? profile.kpis.map((k) => k.name).join(", ") : "None"}
            </p>
            <p>
              <strong>At risk:</strong>{" "}
              {profile.atRisk.length
                ? profile.atRisk.map((g) => g.name).join(", ")
                : "None"}
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Add product / service</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="input"
            placeholder="Offering name"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
          />
          <button
            className="btn btn-primary"
            type="button"
            onClick={async () => {
              try {
                const res = await fetch("/api/business-context", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "create_product", name: productName }),
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Failed");
                toast.success("Product offering added");
                setProductName("");
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
