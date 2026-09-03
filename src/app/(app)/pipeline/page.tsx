"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type Lead = {
  id: string;
  score: number;
  qualificationStatus: string;
  contact: { fullName: string | null; instagramUsername: string | null };
};

type Stage = {
  id: string;
  name: string;
  color: string;
  leads: Lead[];
};

export default function PipelinePage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [loading, setLoading] = useState(true);
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/pipeline");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");
    const next = json.pipeline?.stages ?? [];
    setStages(next);
    setMobileStageId((prev) => prev ?? next[0]?.id ?? null);
  }

  useEffect(() => {
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function moveLead(leadId: string, stageId: string) {
    const res = await workspaceFetch(
      workspaceContext.loadedOrganisationId,
      workspaceContext.workspaceRevision,
      "/api/pipeline",
      {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId, stageId }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Move failed");
      return;
    }
    toast.success("Lead moved");
    await load();
  }

  function exportCsv() {
    const rows = [["Lead", "Username", "Stage", "Score", "Status"]];
    for (const stage of stages) {
      for (const lead of stage.leads) {
        rows.push([
          lead.contact.fullName || "",
          lead.contact.instagramUsername || "",
          stage.name,
          String(lead.score),
          lead.qualificationStatus,
        ]);
      }
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="surface p-6">Loading pipeline…</div>;

  const totalLeads = stages.reduce((n, s) => n + s.leads.length, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        description="Move leads through configurable sales stages. Revenue deals live under Deals."
        actions={
          <>
            <a className="btn btn-secondary" href="/deals">
              Open deals
            </a>
            <button
              className={`btn ${view === "kanban" ? "btn-primary" : "btn-secondary"}`}
              type="button"
              onClick={() => setView("kanban")}
            >
              Kanban
            </button>
            <button
              className={`btn ${view === "table" ? "btn-primary" : "btn-secondary"}`}
              type="button"
              onClick={() => setView("table")}
            >
              Table
            </button>
            <button className="btn btn-primary" type="button" onClick={exportCsv}>
              Export CSV
            </button>
          </>
        }
      />

      {totalLeads === 0 && (
        <EmptyState
          title="Your pipeline is ready — it just needs conversations"
          body="Leads show up here when people message you and the AI qualifies them. Connect Instagram or send a test DM to see the first card appear."
          actionHref="/home"
          actionLabel="Go to Home"
        />
      )}

      {view === "kanban" ? (
        <>
          <div className="md:hidden">
            <label className="block text-sm font-medium">
              Stage
              <select
                className="input mt-1 w-full"
                value={mobileStageId ?? ""}
                onChange={(e) => setMobileStageId(e.target.value)}
                aria-label="Pipeline stage"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.leads.length})
                  </option>
                ))}
              </select>
            </label>
            {stages
              .filter((s) => s.id === mobileStageId)
              .map((stage) => (
                <div key={stage.id} className="surface mt-3 space-y-2 p-3">
                  {stage.leads.map((lead) => (
                    <div
                      key={lead.id}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
                    >
                      <p className="font-medium">{lead.contact.fullName || "Lead"}</p>
                      <p className="text-xs text-[var(--muted)]">
                        @{lead.contact.instagramUsername}
                      </p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="badge badge-success">{lead.score}</span>
                        <select
                          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                          value={stage.id}
                          onChange={(e) => moveLead(lead.id, e.target.value)}
                        >
                          {stages.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                  {stage.leads.length === 0 && (
                    <p className="text-xs text-[var(--muted)]">No leads in this stage.</p>
                  )}
                </div>
              ))}
          </div>
          <div className="relative hidden md:block">
            <div className="flex gap-3 overflow-x-auto pb-4 [scrollbar-gutter:stable]">
              {stages.map((stage) => (
                <div
                  key={stage.id}
                  className="surface sticky top-0 min-w-[260px] max-w-[280px] flex-shrink-0 p-3"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                    <h2 className="font-semibold">{stage.name}</h2>
                    <span className="badge ml-auto">{stage.leads.length}</span>
                  </div>
                  <div className="space-y-2">
                    {stage.leads.map((lead) => (
                      <div
                        key={lead.id}
                        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
                      >
                        <p className="font-medium">{lead.contact.fullName || "Lead"}</p>
                        <p className="text-xs text-[var(--muted)]">
                          @{lead.contact.instagramUsername}
                        </p>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="badge badge-success">{lead.score}</span>
                          <select
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                            value={stage.id}
                            onChange={(e) => moveLead(lead.id, e.target.value)}
                          >
                            {stages.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                    {stage.leads.length === 0 && (
                      <p className="text-xs text-[var(--muted)]">No leads in this stage.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {stages.length > 3 ? (
              <p className="pointer-events-none absolute top-0 right-0 h-full w-8 bg-gradient-to-l from-[var(--background)] to-transparent" />
            ) : null}
          </div>
        </>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Move</th>
              </tr>
            </thead>
            <tbody>
              {stages.flatMap((stage) =>
                stage.leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-[var(--border)]">
                    <td className="px-4 py-3">
                      {lead.contact.fullName}
                      <div className="text-xs text-[var(--muted)]">@{lead.contact.instagramUsername}</div>
                    </td>
                    <td className="px-4 py-3">{stage.name}</td>
                    <td className="px-4 py-3">{lead.score}</td>
                    <td className="px-4 py-3">{lead.qualificationStatus}</td>
                    <td className="px-4 py-3">
                      <select
                        className="input"
                        value={stage.id}
                        onChange={(e) => moveLead(lead.id, e.target.value)}
                      >
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
