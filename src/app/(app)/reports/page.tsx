"use client";

import { useState } from "react";
import { toast } from "sonner";

export default function ReportsPage() {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate(type: "daily" | "weekly") {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports?type=${type}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setPayload(json.payload);
      toast.success(`${type} report generated`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!payload) return;
    const rows = [
      ["metric", "value"],
      ["newConversations", String(payload.newConversations ?? "")],
      ["qualifiedLeads", String(payload.qualifiedLeads ?? "")],
      ["callsBooked", String(payload.callsBooked ?? "")],
      ["followUpsSent", String(payload.followUpsSent ?? "")],
      ["conversionRate", String(payload.conversionRate ?? "")],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSheetsPlaceholder() {
    toast.message("Google Sheets adapter placeholder", {
      description: "Report payload is ready; connect Sheets credentials in Settings to enable export.",
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Reports</h1>
        <p className="text-[var(--muted)]">Daily and weekly performance reports from live data.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={loading} type="button" onClick={() => generate("daily")}>
          Generate daily report
        </button>
        <button className="btn btn-secondary" disabled={loading} type="button" onClick={() => generate("weekly")}>
          Generate weekly report
        </button>
        <button className="btn btn-secondary" disabled={!payload} type="button" onClick={exportCsv}>
          Export CSV
        </button>
        <button className="btn btn-secondary" disabled={!payload} type="button" onClick={exportSheetsPlaceholder}>
          Export to Google Sheets
        </button>
      </div>
      {payload && (
        <pre className="surface overflow-x-auto p-5 text-xs">{JSON.stringify(payload, null, 2)}</pre>
      )}
    </div>
  );
}
