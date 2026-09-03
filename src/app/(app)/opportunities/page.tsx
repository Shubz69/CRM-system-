"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { PageLoading } from "@/components/ui/page-state";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { statusLabel } from "@/lib/customer-labels";

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

function impactWhy(impact: string, urgency: string): string {
  const bits: string[] = [];
  if (urgency && urgency !== "LOW") bits.push(`Urgency: ${statusLabel(urgency).toLowerCase()}`);
  if (impact) bits.push(`Impact: ${statusLabel(impact).toLowerCase()}`);
  return bits.join(" · ") || "Review when you have capacity.";
}

export default function OpportunitiesPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [opportunities, setOpportunities] = useState<Opp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/opportunities");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load opportunities");
    setOpportunities(json.opportunities ?? []);
  }, []);

  useEffect(() => {
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  async function act(action: string, opportunityId: string) {
    setBusyId(opportunityId);
    try {
      const res = await workspaceFetch(
        workspaceContext.loadedOrganisationId,
        workspaceContext.workspaceRevision,
        "/api/opportunities",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, opportunityId }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Action failed");
      return json;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        description="Commercial moves Agent Desk recommends — with evidence you can inspect."
        actions={
          <button
            className="btn btn-secondary"
            type="button"
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              toast.message("Scanning…");
              try {
                const res = await workspaceFetch(
                  workspaceContext.loadedOrganisationId,
                  workspaceContext.workspaceRevision,
                  "/api/opportunities",
                  {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "run_detectors" }),
                  },
                );
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "Scan failed");
                const created = json.result?.created ?? 0;
                const updated = json.result?.updated ?? 0;
                toast.success(
                  created || updated
                    ? `Found ${created} new, updated ${updated}`
                    : "No new opportunities from this scan",
                );
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Scan failed");
              } finally {
                setScanning(false);
              }
            }}
          >
            {scanning ? "Scanning…" : "Scan for opportunities"}
          </button>
        }
      />

      {loading ? (
        <PageLoading label="Loading opportunities" />
      ) : opportunities.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            title="No opportunities detected yet"
            body="Agent Desk watches for stalled qualified leads, pipeline risk, audience demand, market changes, and content opportunities."
            actions={[
              { href: "/crm", label: "Open CRM" },
              { href: "/research", label: "Start research" },
            ]}
          />
          <div className="surface-muted max-w-xl p-5 text-sm">
            <p className="font-medium">How it works</p>
            <p className="mt-1 text-[var(--muted)]">
              Signal → Evidence → Opportunity → You decide
            </p>
            <button
              type="button"
              className="btn btn-primary mt-4"
              onClick={async () => {
                try {
                  const res = await workspaceFetch(
                    workspaceContext.loadedOrganisationId,
                    workspaceContext.workspaceRevision,
                    "/api/opportunities",
                    {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "run_detectors" }),
                    },
                  );
                  const json = await res.json();
                  if (!res.ok) throw new Error(json.error || "Scan failed");
                  toast.success("Scan complete");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                }
              }}
            >
              Scan now
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {opportunities.map((o) => (
            <article key={o.id} className="surface space-y-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="caption">{statusLabel(o.status)}</p>
                  <h3 className="section-title mt-1">{o.title}</h3>
                </div>
                <span className="badge">{statusLabel(o.urgency)} urgency</span>
              </div>

              <p className="text-sm leading-relaxed text-[var(--muted)]">{o.summary}</p>

              <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm">
                <p className="card-title">Why now</p>
                <p className="meta mt-1 leading-relaxed">{impactWhy(o.impact, o.urgency)}</p>
                {o.goal ? (
                  <p className="meta mt-2">Related goal: {o.goal.name}</p>
                ) : null}
              </div>

              {o.evidences && o.evidences.length > 0 ? (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium text-[var(--foreground)]">
                    Evidence ({o.evidences.length})
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--muted)]">
                    {o.evidences.map((e, i) => (
                      <li key={i}>
                        <strong className="text-[var(--foreground)]">{e.label}</strong>
                        {e.detail ? ` — ${e.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {(o.status === "DETECTED" || o.status === "REVIEWED" || o.status === "ACCEPTED") && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busyId === o.id}
                    onClick={async () => {
                      try {
                        await act("create_mission", o.id);
                        toast.success("Accepted — work prepared for follow-through");
                        await load();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      }
                    }}
                  >
                    Accept
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={busyId === o.id}
                    onClick={async () => {
                      try {
                        await act("reject", o.id);
                        toast.success("Dismissed");
                        await load();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      }
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
