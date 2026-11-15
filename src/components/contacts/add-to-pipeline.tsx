"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ContactsApiError, defaultStage, errorText, fetchStages, sendJson, type StageSummary } from "./contacts-api";

type LiveLead = { id: string; stage?: { id?: string; name: string } | null } | null | undefined;

/**
 * Pipeline placement on the contact page: the live lead's stage, or an "Add to pipeline"
 * action ("new" stage by default, or a chosen one) for contacts that have no lead yet.
 */
export function AddToPipeline({
  contactId,
  lead,
  canWrite,
  onChanged,
}: {
  contactId: string;
  lead: LiveLead;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [stages, setStages] = useState<StageSummary[] | null>(null);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [stageId, setStageId] = useState("");
  const [saving, setSaving] = useState(false);
  const needsStages = !lead && canWrite;

  useEffect(() => {
    if (!needsStages) return;
    let cancelled = false;
    fetchStages()
      .then((list) => {
        if (!cancelled) setStages(list);
      })
      .catch((error) => {
        if (!cancelled) setStagesError(errorText(error, "Could not load pipeline stages"));
      });
    return () => {
      cancelled = true;
    };
  }, [needsStages]);

  if (lead) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">Pipeline stage</span>
        <span className="badge badge-success">{lead.stage?.name || "No stage"}</span>
        <Link className="text-xs text-[var(--accent)] underline" href="/pipeline">
          Open pipeline
        </Link>
      </p>
    );
  }

  async function add() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await sendJson<{ lead: { stage: { name: string } } }>(
        `/api/contacts/${contactId}/lead`,
        "POST",
        stageId ? { stageId } : {},
      );
      toast.success(`Added to pipeline · ${res.lead.stage.name}`);
      await onChanged();
    } catch (error) {
      toast.error(errorText(error, "Could not add to the pipeline"));
      // Someone else already added them — show the real state.
      if (error instanceof ContactsApiError && error.status === 409) await onChanged();
    } finally {
      setSaving(false);
    }
  }

  const noStages = stages !== null && stages.length === 0;
  const fallbackStage = defaultStage(stages);

  return (
    <div className="space-y-2 text-sm">
      <p className="text-[var(--muted)]">Not in the pipeline yet.</p>
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input max-w-[15rem] text-sm"
            value={stageId}
            disabled={saving || stages === null || noStages}
            onChange={(e) => setStageId(e.target.value)}
            aria-label="Pipeline stage"
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
            className="btn btn-primary px-3 py-1.5 text-sm"
            disabled={saving || noStages}
            onClick={() => void add()}
          >
            {saving ? "Adding…" : "Add to pipeline"}
          </button>
        </div>
      ) : null}
      {stagesError ? <p className="text-xs text-[var(--danger)]">{stagesError}</p> : null}
      {noStages ? (
        <p className="text-xs text-[var(--muted)]">
          The pipeline has no stages yet. <Link className="underline" href="/pipeline">Set it up</Link> first.
        </p>
      ) : null}
    </div>
  );
}
