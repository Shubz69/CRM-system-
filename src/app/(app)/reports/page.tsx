"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

const METRICS: Array<{ key: string; label: string }> = [
  { key: "newConversations", label: "New conversations" },
  { key: "qualifiedLeads", label: "Qualified leads" },
  { key: "callsBooked", label: "Calls booked" },
  { key: "followUpsSent", label: "Follow-ups sent" },
  { key: "conversionRate", label: "Conversion rate" },
];

function formatMetric(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") {
    if (value > 0 && value < 1) return `${Math.round(value * 1000) / 10}%`;
    return String(value);
  }
  return String(value);
}

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
      ...METRICS.map((m) => [m.key, String(payload[m.key] ?? "")]),
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
      <PageHeader
        description="Daily and weekly performance reports from live data."
        actions={
          <>
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
          </>
        }
      />

      {payload && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METRICS.map((m) => (
            <div key={m.key} className="surface p-4">
              <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{m.label}</p>
              <p className="metric-value mt-2 text-3xl">{formatMetric(payload[m.key])}</p>
            </div>
          ))}
        </div>
      )}

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Generated reports</h2>
        <ul className="mt-3 space-y-2">
          {reports.map((report) => (
            <li key={report.id}>
              <button
                className={`w-full rounded-xl px-3 py-2 text-left hover:bg-[var(--surface-2)] ${
                  activeReportId === report.id ? "bg-[var(--accent-soft)]" : ""
                }`}
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
          {!reports.length && (
            <li>
              <EmptyState
                title="No reports yet"
                body="Generate a daily or weekly snapshot from your live conversations. If you have not connected Instagram, start there first — reports need real activity."
                actionHref="/settings/go-live"
                actionLabel="Finish setup"
              />
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
