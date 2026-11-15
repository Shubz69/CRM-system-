"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { defaultStage, errorText, fetchStages, sendJson, type StageSummary, type TagSummary } from "./contacts-api";

type BulkAction = "add_tag" | "remove_tag" | "add_to_pipeline" | "opt_out" | "delete";

type BulkResult = {
  action: BulkAction;
  requested: number;
  matched: number;
  updated: number;
  unchanged: number;
  /** Contacts the action failed for (opt-out); the others went through. */
  failed?: number;
  notFound: number;
};

export const BULK_LIMIT = 500;

function n(count: number, word = "contact") {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function summary(result: BulkResult, tagName?: string): string {
  const rest = result.unchanged ? ` (${n(result.unchanged)} already done)` : "";
  switch (result.action) {
    case "add_tag":
      return `Tagged ${n(result.updated)} "${tagName}"${rest}`;
    case "remove_tag":
      return `Removed "${tagName}" from ${n(result.updated)}${result.unchanged ? ` (${n(result.unchanged)} didn't have it)` : ""}`;
    case "add_to_pipeline":
      return `Added ${n(result.updated)} to the pipeline${result.unchanged ? ` (${n(result.unchanged)} already there)` : ""}`;
    case "opt_out":
      return `Opted out ${n(result.updated)}${rest}`;
    case "delete":
      return `Deleted ${n(result.updated)}`;
  }
}

/**
 * Action bar for the selected rows on the contacts list. Every action is one request to
 * POST /api/contacts/bulk; delete and opt-out ask first and are offered only to roles that
 * may run them (`canManage`: Owner / Administrator / Manager).
 */
export function BulkActions({
  selectedIds,
  tags,
  canWrite,
  canManage,
  onDone,
  onClear,
}: {
  selectedIds: string[];
  tags: TagSummary[];
  canWrite: boolean;
  canManage: boolean;
  onDone: (action: BulkAction) => Promise<void> | void;
  onClear: () => void;
}) {
  const [tagId, setTagId] = useState("");
  const [stageId, setStageId] = useState("");
  const [stages, setStages] = useState<StageSummary[] | null>(null);
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "opt_out" | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    fetchStages()
      .then((list) => !cancelled && setStages(list))
      .catch(() => !cancelled && setStages([]));
    return () => {
      cancelled = true;
    };
  }, [canWrite]);

  const count = selectedIds.length;
  const tooMany = count > BULK_LIMIT;

  async function run(action: BulkAction) {
    if (busy || !count) return;
    if (tooMany) {
      toast.error(`Select at most ${BULK_LIMIT} contacts for a bulk action.`);
      return;
    }
    setBusy(action);
    try {
      const result = await sendJson<BulkResult>("/api/contacts/bulk", "POST", {
        action,
        contactIds: selectedIds,
        ...(action === "add_tag" || action === "remove_tag" ? { tagId } : {}),
        ...(action === "add_to_pipeline" && stageId ? { stageId } : {}),
      });
      const tagName = tags.find((t) => t.id === tagId)?.name;
      if (result.updated || !result.failed) toast.success(summary(result, tagName));
      if (result.failed) {
        toast.error(`Couldn't opt out ${n(result.failed)} — try again for ${result.failed === 1 ? "it" : "them"}.`);
      }
      if (result.notFound) toast.message(`${n(result.notFound)} no longer exist and were skipped.`);
      setConfirm(null);
      await onDone(action);
    } catch (error) {
      toast.error(errorText(error, "Bulk action failed"));
    } finally {
      setBusy(null);
    }
  }

  if (!count) return null;
  const disabled = Boolean(busy);
  const fallbackStage = defaultStage(stages);

  return (
    <div
      className="surface sticky top-2 z-20 flex flex-wrap items-center gap-2 p-3"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-sm font-semibold">{n(count)} selected</span>
      {tooMany ? <span className="badge badge-danger">Max {BULK_LIMIT}</span> : null}
      {canWrite ? (
        <>
          <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
          <select
            className="input max-w-[15rem] text-sm"
            value={tagId}
            disabled={disabled}
            onChange={(e) => setTagId(e.target.value)}
            aria-label="Tag for bulk action"
          >
            <option value="">{tags.length ? "Choose a tag…" : "No tags yet"}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-sm"
            disabled={disabled || !tagId}
            onClick={() => void run("add_tag")}
          >
            {busy === "add_tag" ? "Tagging…" : "Add tag"}
          </button>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-sm"
            disabled={disabled || !tagId}
            onClick={() => void run("remove_tag")}
          >
            {busy === "remove_tag" ? "Removing…" : "Remove tag"}
          </button>
          <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
          <select
            className="input max-w-[15rem] text-sm"
            value={stageId}
            disabled={disabled || !stages?.length}
            onChange={(e) => setStageId(e.target.value)}
            aria-label="Pipeline stage for bulk action"
          >
            <option value="">{fallbackStage ? `Default stage (${fallbackStage.name})` : "Default stage"}</option>
            {(stages ?? []).map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-sm"
            disabled={disabled || (stages !== null && stages.length === 0)}
            title={stages !== null && stages.length === 0 ? "The pipeline has no stages yet" : undefined}
            onClick={() => void run("add_to_pipeline")}
          >
            {busy === "add_to_pipeline" ? "Adding…" : "Add to pipeline"}
          </button>
          {canManage ? (
            <>
              <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
              <button
                type="button"
                className="btn btn-secondary px-3 py-1.5 text-sm"
                disabled={disabled}
                onClick={() => setConfirm("opt_out")}
              >
                Opt out
              </button>
              <button
                type="button"
                className="btn btn-danger px-3 py-1.5 text-sm"
                disabled={disabled}
                onClick={() => setConfirm("delete")}
              >
                Delete
              </button>
            </>
          ) : null}
        </>
      ) : null}
      <button type="button" className="ml-auto text-sm text-[var(--muted)] underline" disabled={disabled} onClick={onClear}>
        Clear selection
      </button>

      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete ${n(count)}?`}
        confirmLabel={`Delete ${n(count)}`}
        busyLabel="Deleting…"
        busy={busy === "delete"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("delete")}
      >
        <p>
          Their conversations, leads and deals will no longer appear in the inbox, pipeline or reports. A person who
          messages you again on Instagram comes back as a contact.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "opt_out"}
        title={`Opt out ${n(count)}?`}
        confirmLabel="Opt out"
        busyLabel="Opting out…"
        busy={busy === "opt_out"}
        danger={false}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("opt_out")}
      >
        <p>
          No more messages or follow-ups will be sent to them. You can clear an opt-out later from the contact&apos;s
          page.
        </p>
      </ConfirmDialog>
    </div>
  );
}
