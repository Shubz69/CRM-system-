"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AutopilotPanel } from "@/components/autopilot-panel";
import { PageHeader } from "@/components/ui/page-header";
import { DEFAULT_AUTOPILOT_CONFIG, type AutopilotCapability } from "@/lib/autopilot-config";

const CAPABILITIES: { key: AutopilotCapability; label: string; hint: string }[] = [
  { key: "aiResponses", label: "AI Responses", hint: "Reply to Instagram DMs automatically" },
  { key: "qualification", label: "Qualification", hint: "Ask and extract qualification answers" },
  { key: "pipelineManagement", label: "Pipeline Management", hint: "Move leads through stages" },
  { key: "leadScoring", label: "Lead Scoring", hint: "Update scores after each message" },
  { key: "followUps", label: "Follow Ups", hint: "Schedule permitted follow-ups" },
  { key: "booking", label: "Booking", hint: "Send booking links when ready" },
  { key: "contactEnrichment", label: "Contact Enrichment", hint: "Fill CRM memory fields" },
  { key: "insights", label: "Insights", hint: "Aggregate objections and questions" },
  { key: "contentRecommendations", label: "Content Recommendations", hint: "Suggest content from gaps" },
];

type Mode = "automatic" | "approval_required" | "disabled";

export default function AutopilotPage() {
  const [config, setConfig] = useState<Record<string, Mode>>({ ...DEFAULT_AUTOPILOT_CONFIG });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/autopilot")
      .then(async (r) => {
        const j = await r.json();
        if (r.ok && j.config) setConfig(j.config);
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/autopilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success("Autopilot settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader description="Configure once. Connect Instagram. Turn Autopilot on. Humans handle exceptions." />

      <AutopilotPanel />

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Capability modes</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Each capability can run automatically, require approval, or stay disabled.
        </p>
        <div className="mt-4 space-y-3">
          {CAPABILITIES.map((cap) => (
            <div
              key={cap.key}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)]/50 py-3"
            >
              <div>
                <p className="font-medium">{cap.label}</p>
                <p className="text-xs text-[var(--muted)]">{cap.hint}</p>
              </div>
              <select
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                value={config[cap.key] || "automatic"}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, [cap.key]: e.target.value as Mode }))
                }
              >
                <option value="automatic">Automatic</option>
                <option value="approval_required">Approval required</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-primary mt-4" disabled={saving} onClick={() => void save()}>
          Save Autopilot settings
        </button>
      </section>
    </div>
  );
}
