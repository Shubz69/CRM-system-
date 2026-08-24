"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type Opp = {
  id: string;
  type: string;
  title: string;
  summary: string;
  status: string;
  impact: string;
  urgency: string;
  confidence: string;
  priorityScore: number;
  goal?: { id: string; name: string } | null;
  evidences?: Array<{ label: string; detail: string | null }>;
};

export default function OpportunitiesPage() {
  const [opportunities, setOpportunities] = useState<Opp[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/opportunities");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load opportunities");
    setOpportunities(json.opportunities ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  async function act(action: string, opportunityId: string) {
    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, opportunityId }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Action failed");
    return json;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        description="Prioritised business opportunities with inspectable evidence — not CRM deals."
        actions={
          <button
            className="btn btn-secondary"
            type="button"
            onClick={async () => {
              try {
                const res = await fetch("/api/opportunities", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "run_detectors" }),
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Detector run failed");
                toast.success(
                  `Detectors: +${json.result?.created ?? 0} created, ${json.result?.updated ?? 0} updated`,
                );
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Run detectors
          </button>
        }
      />

      {opportunities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No opportunities yet. Run detectors when CRM activity exists, or wait for the worker sweep.
        </p>
      ) : (
        <div className="space-y-4">
          {opportunities.map((o) => (
            <article key={o.id} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{o.title}</h3>
                <span className="text-xs uppercase">{o.status}</span>
              </div>
              <p className="text-sm text-muted-foreground">{o.summary}</p>
              <p className="text-xs">
                {o.type} · impact {o.impact} · urgency {o.urgency} · confidence {o.confidence} ·
                score {o.priorityScore}
                {o.goal ? ` · goal: ${o.goal.name}` : ""}
              </p>
              {o.evidences && o.evidences.length > 0 && (
                <ul className="text-sm list-disc pl-5">
                  {o.evidences.map((e, i) => (
                    <li key={i}>
                      <strong>{e.label}</strong>
                      {e.detail ? ` — ${e.detail}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {(o.status === "DETECTED" || o.status === "REVIEWED" || o.status === "ACCEPTED") && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={async () => {
                      try {
                        const json = await act("create_mission", o.id);
                        toast.success(`Mission ${json.missionId} created`);
                        await load();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      }
                    }}
                  >
                    Accept → Mission
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={async () => {
                      try {
                        await act("reject", o.id);
                        toast.success("Rejected");
                        await load();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      }
                    }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
