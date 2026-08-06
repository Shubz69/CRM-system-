"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function ReportsPage() {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState<
    Array<{ id: string; title: string; type: string; createdAt: string; payload: Record<string, unknown> }>
  >([]);

  async function loadReports() {
    const response = await fetch("/api/reports");
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed");
    setReports(json.reports);
  }

  useEffect(() => {
    loadReports().catch((error) => toast.error(error.message));
  }, []);

  async function generate(type: "daily" | "weekly") {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports?type=${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setPayload(json.payload);
      setActiveReportId(json.report?.id ?? null);
      await loadReports();
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

  async function exportSheets() {
    if (!activeReportId) {
      toast.error("Generate or select a report first");
      return;
    }
    try {
      const res = await fetch("/api/reports/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: activeReportId, destination: "sheets" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Export failed");
      toast.success(
        json.result?.destination
          ? `Exported via ${json.result.provider}`
          : "Sheets export recorded",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
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
        <button className="btn btn-secondary" disabled={!activeReportId} type="button" onClick={exportSheets}>
          Export to Google Sheets
        </button>
      </div>
      {payload && (
        <pre className="surface overflow-x-auto p-5 text-xs">{JSON.stringify(payload, null, 2)}</pre>
      )}
      <section className="surface p-5">
        <h2 className="h-display text-2xl">Generated reports</h2>
        <ul className="mt-3 space-y-2">
          {reports.map((report) => (
            <li key={report.id}>
              <button
                className="text-left hover:underline"
                type="button"
                onClick={() => {
                  setPayload(report.payload);
                  setActiveReportId(report.id);
                }}
              >
                {report.title} · {report.type} · {new Date(report.createdAt).toLocaleString()}
              </button>
            </li>
          ))}
          {!reports.length && <li className="text-[var(--muted)]">No reports generated yet.</li>}
        </ul>
      </section>
    </div>
  );
}
