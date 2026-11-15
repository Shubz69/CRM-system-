"use client";

import { useState } from "react";
import { toast } from "sonner";

export type WebhookRow = {
  id: string;
  provider: string;
  eventType: string;
  status: string;
  organisationName: string | null;
  createdAt: string;
  processedAt: string | null;
  error: string | null;
  idempotencyKey: string;
  attempts?: number;
};

/** Error the old retry wrote when it wrongly gave up on a replayable event (see replay.ts). */
const LEGACY_UNRETRIABLE_ERROR = "Payload is not a retriable inbound message shape";
/** A row still PROCESSING this long after it arrived was abandoned (matches the retry route). */
const STUCK_PROCESSING_MS = 10 * 60 * 1000;

export function WebhooksClient({ initial }: { initial: WebhookRow[] }) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Page-load time: decides whether a PROCESSING row is old enough to count as abandoned.
  const [loadedAt] = useState(() => Date.now());

  async function retry(id: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/admin/webhooks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookEventId: id }),
      });
      const json = await res.json();
      if (typeof json.status === "string") {
        // Show the event's real state — a failed or ignored replay must stay visible.
        setRows((prev) =>
          prev.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: json.status,
                  error: json.status === "PROCESSED" ? null : r.error,
                  processedAt:
                    json.status === "PROCESSED" ? new Date().toISOString() : r.processedAt,
                }
              : r,
          ),
        );
      }
      if (!res.ok) throw new Error(json.error || "Retry failed");
      if (json.status === "PROCESSED" || json.duplicate) {
        toast.success(json.message || "Retry completed");
      } else {
        toast.message(json.message || "Retry finished");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Provider</th>
              <th className="px-3 py-3">Workspace</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">External / Key</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Received</th>
              <th className="px-3 py-3">Processed</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id} className="border-b border-[var(--border)]/60">
                <td className="px-3 py-3">{event.provider}</td>
                <td className="px-3 py-3">{event.organisationName || "—"}</td>
                <td className="px-3 py-3">{event.eventType}</td>
                <td className="max-w-[160px] truncate px-3 py-3 text-xs text-[var(--muted)]">
                  {event.idempotencyKey}
                </td>
                <td className="px-3 py-3">{event.status}</td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {new Date(event.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {event.processedAt ? new Date(event.processedAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      className="text-left text-[var(--accent)] hover:underline"
                      onClick={() => setSelected(event)}
                    >
                      Inspect
                    </button>
                    {(event.status === "FAILED" ||
                      event.status === "RECEIVED" ||
                      (event.status === "PROCESSING" &&
                        loadedAt - new Date(event.createdAt).getTime() > STUCK_PROCESSING_MS) ||
                      (event.status === "IGNORED" && event.error === LEGACY_UNRETRIABLE_ERROR)) && (
                      <button
                        type="button"
                        className="text-left text-[var(--accent)] hover:underline"
                        disabled={busy === event.id}
                        onClick={() => void retry(event.id)}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-6 text-sm text-[var(--muted)]">No webhook events yet.</p>
        )}
      </div>

      {selected && (
        <div className="surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="h-display text-xl">Event detail</h2>
            <button type="button" className="btn btn-secondary" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Safe metadata only — raw secrets are never shown.
          </p>
          <pre className="mt-3 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">
            {JSON.stringify(selected, null, 2)}
          </pre>
          {selected.error && (
            <p className="mt-3 text-sm text-[var(--danger)]">Error: {selected.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
