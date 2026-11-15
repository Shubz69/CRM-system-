"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp } from "lucide-react";
import { brokenFunnelPair } from "@/lib/pipeline-funnel";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

export type EditableStage = {
  id: string;
  name: string;
  slug: string;
  color: string;
  isWon: boolean;
  isLost: boolean;
  isSystem: boolean;
  leadCount: number;
};

type Outcome = "open" | "won" | "lost";
type Draft = { name: string; color: string; outcome: Outcome };

const DEFAULT_COLOR = "#64748b";

const FUNNEL_ORDER_HINT =
  "Built-in stages keep their order (New → … → Won) because the AI only moves leads forward";

function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_COLOR;
}

function outcomeOf(stage: { isWon: boolean; isLost: boolean }): Outcome {
  return stage.isWon ? "won" : stage.isLost ? "lost" : "open";
}

function outcomeFlags(outcome: Outcome): { isWon: boolean; isLost: boolean } {
  return { isWon: outcome === "won", isLost: outcome === "lost" };
}

function draftOf(stage: EditableStage): Draft {
  return { name: stage.name, color: safeColor(stage.color), outcome: outcomeOf(stage) };
}

async function send(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const ctx = getImmutableWorkspaceContext(null);
  const res = await workspaceFetch(ctx.loadedOrganisationId, ctx.workspaceRevision, url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, json };
}

function errorText(json: Record<string, unknown>, fallback: string): string {
  return typeof json.error === "string" && json.error ? json.error : fallback;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Add, rename, recolour, mark won/lost, reorder and delete pipeline stages. */
export function StageEditor({
  stages,
  onChanged,
}: {
  stages: EditableStage[];
  onChanged: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ stageId: string; moveTo: string; leadCount: number } | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  const [newOutcome, setNewOutcome] = useState<Outcome>("open");

  async function run(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch {
      toast.error("Network error — check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  function updateDraft(stage: EditableStage, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [stage.id]: { ...(prev[stage.id] ?? draftOf(stage)), ...patch } }));
  }

  function resetDraft(stageId: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[stageId];
      return next;
    });
  }

  function isDirty(stage: EditableStage, draft: Draft): boolean {
    return (
      draft.name.trim() !== stage.name ||
      draft.color !== safeColor(stage.color) ||
      draft.outcome !== outcomeOf(stage)
    );
  }

  function save(stage: EditableStage) {
    const draft = drafts[stage.id] ?? draftOf(stage);
    const name = draft.name.trim();
    if (!name) {
      toast.error("Stage name is required");
      return;
    }
    const payload: Record<string, unknown> = {};
    if (name !== stage.name) payload.name = name;
    if (draft.color !== safeColor(stage.color)) payload.color = draft.color;
    if (draft.outcome !== outcomeOf(stage)) Object.assign(payload, outcomeFlags(draft.outcome));
    if (Object.keys(payload).length === 0) {
      resetDraft(stage.id);
      return;
    }
    void run(`save:${stage.id}`, async () => {
      const res = await send(`/api/pipeline/stages/${encodeURIComponent(stage.id)}`, "PATCH", payload);
      if (!res.ok) {
        toast.error(errorText(res.json, "Couldn't save the stage"));
        return;
      }
      toast.success("Stage saved");
      resetDraft(stage.id);
      await onChanged();
    });
  }

  /** Swapping with the neighbour: off the list, or would break the built-in funnel order. */
  function moveBlocked(index: number, direction: -1 | 1): boolean {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return true;
    const slugs = stages.map((s) => s.slug);
    const next = slugs.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    return brokenFunnelPair(slugs, next) !== null;
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (moveBlocked(index, direction)) return;
    const ids = stages.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(`move:${stages[index]!.id}`, async () => {
      const res = await send("/api/pipeline/stages", "PATCH", { stageIds: ids });
      if (!res.ok) {
        toast.error(errorText(res.json, "Couldn't reorder the stages"));
        return;
      }
      await onChanged();
    });
  }

  function firstOtherStage(stageId: string): string {
    return stages.find((s) => s.id !== stageId)?.id ?? "";
  }

  function deleteStage(stage: EditableStage, moveTo: string | null) {
    void run(`delete:${stage.id}`, async () => {
      const query = moveTo ? `?moveLeadsTo=${encodeURIComponent(moveTo)}` : "";
      const res = await send(`/api/pipeline/stages/${encodeURIComponent(stage.id)}${query}`, "DELETE");
      if (!res.ok) {
        if (res.status === 409 && res.json.code === "STAGE_HAS_LEADS") {
          // The board was out of date: ask where the leads should go.
          setDeleting({
            stageId: stage.id,
            moveTo: firstOtherStage(stage.id),
            leadCount: typeof res.json.leadCount === "number" ? res.json.leadCount : stage.leadCount,
          });
        }
        toast.error(errorText(res.json, "Couldn't delete the stage"));
        return;
      }
      const movedLeads = typeof res.json.movedLeads === "number" ? res.json.movedLeads : 0;
      toast.success(movedLeads > 0 ? `Stage deleted — ${plural(movedLeads, "lead")} moved` : "Stage deleted");
      setDeleting(null);
      resetDraft(stage.id);
      await onChanged();
    });
  }

  function startDelete(stage: EditableStage) {
    if (stage.leadCount > 0) {
      setDeleting({ stageId: stage.id, moveTo: firstOtherStage(stage.id), leadCount: stage.leadCount });
      return;
    }
    if (!window.confirm(`Delete the "${stage.name}" stage? This can't be undone.`)) return;
    deleteStage(stage, null);
  }

  function confirmDeleteWithMove(stage: EditableStage) {
    if (!deleting?.moveTo) {
      toast.error("Choose a stage to move the leads to");
      return;
    }
    const target = stages.find((s) => s.id === deleting.moveTo);
    if (
      !window.confirm(
        `Delete the "${stage.name}" stage and move its ${plural(deleting.leadCount, "lead")} to "${target?.name ?? "the chosen stage"}"? This can't be undone.`,
      )
    ) {
      return;
    }
    deleteStage(stage, deleting.moveTo);
  }

  function addStage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run("add", async () => {
      const res = await send("/api/pipeline/stages", "POST", {
        name,
        color: newColor,
        ...outcomeFlags(newOutcome),
      });
      if (!res.ok) {
        toast.error(errorText(res.json, "Couldn't add the stage"));
        return;
      }
      toast.success(`Stage "${name}" added`);
      setNewName("");
      setNewOutcome("open");
      await onChanged();
    });
  }

  const disabled = busy !== null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        Built-in stages are the ones the AI moves leads into, so they can be renamed and recoloured
        but not deleted, and the New → … → Won stages keep their order (the AI only moves leads
        forward). Your own stages can be changed and placed freely.
      </p>

      {stages.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">This pipeline has no stages yet.</p>
      ) : (
        <ol className="space-y-2">
          {stages.map((stage, index) => {
            const draft = drafts[stage.id] ?? draftOf(stage);
            const dirty = isDirty(stage, draft);
            const deletingThis = deleting?.stageId === stage.id;
            const upBlocked = moveBlocked(index, -1);
            const downBlocked = moveBlocked(index, 1);
            return (
              <li
                key={stage.id}
                className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className="h-9 w-9 flex-shrink-0 cursor-pointer rounded-md border border-[var(--border)] bg-transparent p-0.5"
                    value={draft.color}
                    onChange={(e) => updateDraft(stage, { color: e.target.value })}
                    disabled={disabled}
                    aria-label={`Colour for ${stage.name}`}
                  />
                  <input
                    className="input min-w-0 flex-1"
                    value={draft.name}
                    maxLength={60}
                    onChange={(e) => updateDraft(stage, { name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save(stage);
                      }
                    }}
                    disabled={disabled}
                    aria-label={`Name of stage ${index + 1}`}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary px-2 py-1.5"
                    onClick={() => move(index, -1)}
                    disabled={disabled || upBlocked}
                    aria-label={`Move ${stage.name} up`}
                    title={index > 0 && upBlocked ? FUNNEL_ORDER_HINT : undefined}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary px-2 py-1.5"
                    onClick={() => move(index, 1)}
                    disabled={disabled || downBlocked}
                    aria-label={`Move ${stage.name} down`}
                    title={index < stages.length - 1 && downBlocked ? FUNNEL_ORDER_HINT : undefined}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <select
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                    value={draft.outcome}
                    onChange={(e) => updateDraft(stage, { outcome: e.target.value as Outcome })}
                    disabled={disabled || stage.isSystem}
                    aria-label={`Outcome of ${stage.name}`}
                    title={stage.isSystem ? "Won/lost is fixed for built-in stages" : undefined}
                  >
                    <option value="open">Open stage</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                  {stage.isSystem ? (
                    <span className="badge" title="Used by the AI — can't be deleted">
                      Built-in
                    </span>
                  ) : null}
                  <span className="text-[var(--muted)]">{plural(stage.leadCount, "lead")}</span>
                  <span className="ml-auto flex gap-2">
                    {dirty ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary px-2.5 py-1 text-xs"
                          onClick={() => resetDraft(stage.id)}
                          disabled={disabled}
                        >
                          Undo
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary px-2.5 py-1 text-xs"
                          onClick={() => save(stage)}
                          disabled={disabled || !draft.name.trim()}
                        >
                          {busy === `save:${stage.id}` ? "Saving…" : "Save"}
                        </button>
                      </>
                    ) : null}
                    {!stage.isSystem && !deletingThis ? (
                      <button
                        type="button"
                        className="btn btn-danger px-2.5 py-1 text-xs"
                        onClick={() => startDelete(stage)}
                        disabled={disabled}
                      >
                        Delete
                      </button>
                    ) : null}
                  </span>
                </div>
                {deletingThis && deleting ? (
                  <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-attention)] p-2.5">
                    <p className="text-xs">
                      &ldquo;{stage.name}&rdquo; has {plural(deleting.leadCount, "lead")}. Choose where{" "}
                      {deleting.leadCount === 1 ? "it goes" : "they go"} before deleting the stage.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                        value={deleting.moveTo}
                        onChange={(e) => setDeleting({ ...deleting, moveTo: e.target.value })}
                        disabled={disabled}
                        aria-label="Move leads to"
                      >
                        {stages
                          .filter((s) => s.id !== stage.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-danger px-2.5 py-1 text-xs"
                        onClick={() => confirmDeleteWithMove(stage)}
                        disabled={disabled || !deleting.moveTo}
                      >
                        {busy === `delete:${stage.id}` ? "Deleting…" : "Move leads & delete"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary px-2.5 py-1 text-xs"
                        onClick={() => setDeleting(null)}
                        disabled={disabled}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <form
        className="space-y-2 rounded-xl border border-dashed border-[var(--border-strong)] p-3"
        onSubmit={addStage}
      >
        <p className="text-sm font-medium">Add a stage</p>
        <div className="flex items-center gap-2">
          <input
            type="color"
            className="h-9 w-9 flex-shrink-0 cursor-pointer rounded-md border border-[var(--border)] bg-transparent p-0.5"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            disabled={disabled}
            aria-label="Colour for the new stage"
          />
          <input
            className="input min-w-0 flex-1"
            placeholder="e.g. Proposal sent"
            value={newName}
            maxLength={60}
            onChange={(e) => setNewName(e.target.value)}
            disabled={disabled}
            aria-label="New stage name"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <select
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            value={newOutcome}
            onChange={(e) => setNewOutcome(e.target.value as Outcome)}
            disabled={disabled}
            aria-label="Outcome of the new stage"
          >
            <option value="open">Open stage</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
          <button type="submit" className="btn btn-primary" disabled={disabled || !newName.trim()}>
            {busy === "add" ? "Adding…" : "Add stage"}
          </button>
        </div>
      </form>
    </div>
  );
}
