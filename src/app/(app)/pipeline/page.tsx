"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageError } from "@/components/ui/page-state";
import { SlideOver } from "@/components/ui/slide-over";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { csvRow } from "@/lib/csv";
import { StageEditor, type EditableStage } from "./stage-editor";

type Lead = {
  id: string;
  score: number;
  qualificationStatus: string;
  contact: { fullName: string | null; instagramUsername: string | null };
};

type Stage = {
  id: string;
  name: string;
  slug: string;
  color: string;
  isWon: boolean;
  isLost: boolean;
  isSystem?: boolean;
  leads: Lead[];
};

type Permissions = { manageStages: boolean; moveLeads: boolean };

/** Matches the server's per-request cap on POST /api/pipeline/bulk. */
const MAX_BULK = 500;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorText(json: Record<string, unknown>, fallback: string): string {
  return typeof json.error === "string" && json.error ? json.error : fallback;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Checkbox that can show "some selected". */
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      title={label}
    />
  );
}

function LeadCard({
  lead,
  stage,
  stages,
  selectable,
  selected,
  disabled,
  onToggle,
  onMove,
}: {
  lead: Lead;
  stage: Stage;
  stages: Stage[];
  selectable: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (leadId: string) => void;
  onMove: (leadId: string, stageId: string) => void;
}) {
  const name = lead.contact.fullName || "Lead";
  return (
    <div
      className={`rounded-xl border bg-[var(--surface)] p-3 ${
        selected ? "border-[var(--accent)]" : "border-[var(--border)]"
      }`}
    >
      <div className="flex items-start gap-2">
        {selectable ? (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 flex-shrink-0"
            checked={selected}
            onChange={() => onToggle(lead.id)}
            aria-label={`Select ${name}`}
          />
        ) : null}
        <div className="min-w-0">
          <p className="font-medium">{name}</p>
          {lead.contact.instagramUsername ? (
            <p className="text-xs text-[var(--muted)]">@{lead.contact.instagramUsername}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="badge badge-success">{lead.score}</span>
        {selectable ? (
          <select
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            value={stage.id}
            onChange={(e) => onMove(lead.id, e.target.value)}
            disabled={disabled}
            aria-label={`Move ${name} to stage`}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

export default function PipelinePage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [permissions, setPermissions] = useState<Permissions>({ manageStages: false, moveLeads: true });
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mobileStageId, setMobileStageId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkTarget, setBulkTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const load = useCallback(async () => {
    const res = await fetch("/api/pipeline", { cache: "no-store" });
    const json = await readJson(res);
    if (!res.ok) throw new Error(errorText(json, "Couldn't load the pipeline"));
    const pipeline = json.pipeline as { stages?: Stage[] } | null | undefined;
    const next = pipeline?.stages ?? [];
    setStages(next);
    const perms = json.permissions as Partial<Permissions> | undefined;
    setPermissions({
      manageStages: Boolean(perms?.manageStages),
      moveLeads: perms?.moveLeads ?? true,
    });
    setMobileStageId((prev) =>
      prev && next.some((s) => s.id === prev) ? prev : (next[0]?.id ?? null),
    );
    // Forget selections for leads that left the board, and a deleted bulk target.
    const onBoard = new Set(next.flatMap((s) => s.leads.map((l) => l.id)));
    setSelected((prev) => {
      const kept = [...prev].filter((id) => onBoard.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    setBulkTarget((prev) => (prev && next.some((s) => s.id === prev) ? prev : ""));
  }, []);

  const initialLoad = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the pipeline");
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void initialLoad();
  }, [initialLoad]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't refresh the pipeline");
    }
  }, [load]);

  async function moveLead(leadId: string, stageId: string) {
    if (busy) return;
    setBusy(true);
    try {
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
      const json = await readJson(res);
      if (!res.ok) {
        toast.error(errorText(json, "Move failed"));
        return;
      }
      toast.success("Lead moved");
      await refresh();
    } catch {
      toast.error("Move failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function bulkMove() {
    if (busy || selected.size === 0 || !bulkTarget) return;
    if (selected.size > MAX_BULK) {
      toast.error(`You can move at most ${MAX_BULK} leads at once`);
      return;
    }
    const target = stages.find((s) => s.id === bulkTarget);
    setBusy(true);
    try {
      const res = await workspaceFetch(
        workspaceContext.loadedOrganisationId,
        workspaceContext.workspaceRevision,
        "/api/pipeline/bulk",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadIds: [...selected], stageId: bulkTarget }),
        },
      );
      const json = await readJson(res);
      if (!res.ok) {
        toast.error(errorText(json, "Move failed"));
        return;
      }
      const moved = typeof json.moved === "number" ? json.moved : 0;
      const unchanged = typeof json.unchanged === "number" ? json.unchanged : 0;
      const notFound = typeof json.notFound === "number" ? json.notFound : 0;
      const parts = [`Moved ${plural(moved, "lead")} to ${target?.name ?? "the stage"}`];
      if (unchanged > 0) parts.push(`${unchanged} already there`);
      if (notFound > 0) parts.push(`${notFound} no longer on the board`);
      toast.success(parts.join(" · "));
      setSelected(new Set());
      await refresh();
    } catch {
      toast.error("Move failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggleLead(leadId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  function toggleMany(leadIds: string[]) {
    setSelected((prev) => {
      const allSelected = leadIds.length > 0 && leadIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of leadIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function selectionState(leadIds: string[]) {
    const count = leadIds.filter((id) => selected.has(id)).length;
    return { checked: leadIds.length > 0 && count === leadIds.length, indeterminate: count > 0 && count < leadIds.length };
  }

  function exportCsv() {
    const rows: Array<Array<string | number>> = [["Lead", "Username", "Stage", "Score", "Status"]];
    for (const stage of stages) {
      for (const lead of stage.leads) {
        rows.push([
          lead.contact.fullName || "",
          lead.contact.instagramUsername || "",
          stage.name,
          lead.score,
          lead.qualificationStatus,
        ]);
      }
    }
    // csvRow neutralises formula cells (names come from Instagram, e.g. "=HYPERLINK(...)").
    const csv = rows.map(csvRow).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="surface p-6">Loading pipeline…</div>;
  if (loadError && stages.length === 0) {
    return <PageError message={loadError} onRetry={() => void initialLoad()} />;
  }

  const totalLeads = stages.reduce((n, s) => n + s.leads.length, 0);
  const selectable = permissions.moveLeads;
  const allLeadIds = stages.flatMap((s) => s.leads.map((l) => l.id));
  const editableStages: EditableStage[] = stages.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    color: s.color,
    isWon: s.isWon,
    isLost: s.isLost,
    isSystem: Boolean(s.isSystem),
    leadCount: s.leads.length,
  }));

  function stageHeaderCheckbox(stage: Stage) {
    if (!selectable || stage.leads.length === 0) return null;
    const state = selectionState(stage.leads.map((l) => l.id));
    return (
      <SelectAllCheckbox
        checked={state.checked}
        indeterminate={state.indeterminate}
        onChange={() => toggleMany(stage.leads.map((l) => l.id))}
        label={`Select all leads in ${stage.name}`}
        disabled={busy}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        description="Move leads through configurable sales stages. Revenue deals live under Deals."
        actions={
          <>
            <a className="btn btn-secondary" href="/deals">
              Open deals
            </a>
            {permissions.manageStages ? (
              <button className="btn btn-secondary" type="button" onClick={() => setEditorOpen(true)}>
                Edit stages
              </button>
            ) : null}
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

      {selectable && selected.size > 0 ? (
        <div
          className="surface sticky top-2 z-20 flex flex-wrap items-center gap-2 p-3"
          role="region"
          aria-label="Bulk move"
        >
          <span className="text-sm font-medium">{plural(selected.size, "lead")} selected</span>
          <select
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
            value={bulkTarget}
            onChange={(e) => setBulkTarget(e.target.value)}
            disabled={busy}
            aria-label="Move selected leads to stage"
          >
            <option value="">Move to stage…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void bulkMove()}
            disabled={busy || !bulkTarget || selected.size > MAX_BULK}
          >
            {busy ? "Moving…" : "Move"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setSelected(new Set())}
            disabled={busy}
          >
            Clear selection
          </button>
          {selected.size > MAX_BULK ? (
            <span className="text-xs text-[var(--danger)]">
              Select at most {MAX_BULK} leads per move.
            </span>
          ) : null}
        </div>
      ) : null}

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
                  {selectable && stage.leads.length > 0 ? (
                    <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                      {stageHeaderCheckbox(stage)}
                      Select all in {stage.name}
                    </label>
                  ) : null}
                  {stage.leads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      stage={stage}
                      stages={stages}
                      selectable={selectable}
                      selected={selected.has(lead.id)}
                      disabled={busy}
                      onToggle={toggleLead}
                      onMove={(leadId, stageId) => void moveLead(leadId, stageId)}
                    />
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
                    {stageHeaderCheckbox(stage)}
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                    <h2 className="font-semibold">{stage.name}</h2>
                    <span className="badge ml-auto">{stage.leads.length}</span>
                  </div>
                  <div className="space-y-2">
                    {stage.leads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        stage={stage}
                        stages={stages}
                        selectable={selectable}
                        selected={selected.has(lead.id)}
                        disabled={busy}
                        onToggle={toggleLead}
                        onMove={(leadId, stageId) => void moveLead(leadId, stageId)}
                      />
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
                {selectable ? (
                  <th className="w-10 px-4 py-3">
                    {allLeadIds.length > 0 ? (
                      <SelectAllCheckbox
                        {...selectionState(allLeadIds)}
                        onChange={() => toggleMany(allLeadIds)}
                        label="Select all leads"
                        disabled={busy}
                      />
                    ) : null}
                  </th>
                ) : null}
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Status</th>
                {selectable ? <th className="px-4 py-3">Move</th> : null}
              </tr>
            </thead>
            <tbody>
              {stages.flatMap((stage) =>
                stage.leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-[var(--border)]">
                    {selectable ? (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={selected.has(lead.id)}
                          onChange={() => toggleLead(lead.id)}
                          aria-label={`Select ${lead.contact.fullName || "lead"}`}
                        />
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      {lead.contact.fullName}
                      {lead.contact.instagramUsername ? (
                        <div className="text-xs text-[var(--muted)]">@{lead.contact.instagramUsername}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{stage.name}</td>
                    <td className="px-4 py-3">{lead.score}</td>
                    <td className="px-4 py-3">{lead.qualificationStatus}</td>
                    {selectable ? (
                      <td className="px-4 py-3">
                        <select
                          className="input"
                          value={stage.id}
                          onChange={(e) => void moveLead(lead.id, e.target.value)}
                          disabled={busy}
                          aria-label={`Move ${lead.contact.fullName || "lead"} to stage`}
                        >
                          {stages.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      {permissions.manageStages ? (
        <SlideOver
          open={editorOpen}
          onClose={closeEditor}
          title="Edit stages"
          description="Changes apply to everyone in this workspace."
          wide
        >
          <StageEditor stages={editableStages} onChanged={refresh} />
        </SlideOver>
      ) : null}
    </div>
  );
}
