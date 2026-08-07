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

export function WebhooksClient({ initial }: { initial: WebhookRow[] }) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function retry(id: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/admin/webhooks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookEventId: id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Retry failed");
      toast.success(json.duplicate ? "Already processed" : "Retry completed");
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "PROCESSED", error: null } : r)),
      );
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
                    {(event.status === "FAILED" || event.status === "RECEIVED") && (
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
