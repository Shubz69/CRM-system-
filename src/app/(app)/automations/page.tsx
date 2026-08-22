"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

type WorkflowStep = {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  gated?: boolean;
};

type Rule = {
  id: string;
  name: string;
  description: string | null;
  triggerType: string;
  isActive: boolean;
  conditions: unknown;
  actions: unknown;
  workflow?: { steps?: WorkflowStep[] } | null;
  requiresApproval?: boolean;
  executions: Array<{ id: string; status: string; createdAt: string }>;
};

type Approval = {
  id: string;
  title: string;
  status: string;
  kind: string;
  createdAt: string;
  automationRule?: { name: string } | null;
};

function summarizeActions(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return "none";
  return actions
    .map((action) => {
      if (action && typeof action === "object" && "type" in action) {
        return String((action as { type: unknown }).type);
      }
      return "unknown";
    })
    .join(", ");
}

export default function AutomationsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("lead_created");
  const [actionType, setActionType] = useState("send_follow_up");
  const [nl, setNl] = useState("");
  const [preview, setPreview] = useState<WorkflowStep[] | null>(null);

  async function load() {
    const [rulesRes, approvalsRes] = await Promise.all([
      fetch("/api/automations"),
      fetch("/api/approvals"),
    ]);
    const rulesJson = await rulesRes.json();
    if (!rulesRes.ok) throw new Error(rulesJson.error || "Failed");
    setRules(rulesJson.rules);
    if (approvalsRes.ok) {
      const a = await approvalsRes.json();
      setApprovals(a.approvals ?? []);
    }
  }

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, []);

  async function createRule(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, triggerType, actions: [{ type: actionType }] }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    setName("");
    await load();
    toast.success("Rule created");
  }

  async function compileNl(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "compile", naturalLanguage: nl }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Compile failed");
    setPreview(json.workflow?.steps ?? []);
    toast.success("Compiled to visible workflow (not enabled yet)");
  }

  async function saveNlRule() {
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_from_nl",
        name: name || "NL automation",
        naturalLanguage: nl,
      }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    toast.success("Saved as inactive — review workflow, then enable");
    setNl("");
    setPreview(null);
    await load();
  }

  async function toggle(rule: Rule) {
    const response = await fetch("/api/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }),
    });
    if (!response.ok) return toast.error("Unable to update rule");
    await load();
  }

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    const response = await fetch("/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    toast.success(decision === "APPROVED" ? "Approved — actions ran" : "Rejected");
    await load();
  }

  return (
    <div className="space-y-6">
      <PageHeader description="NL compiles to a visible workflow first. Outbound actions need approval. Workers run rules — not the browser." />

      <form className="surface space-y-3 p-4" onSubmit={compileNl}>
        <label className="block text-sm font-medium">
          Describe an automation (natural language)
          <textarea
            className="input mt-1 min-h-24 w-full"
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            placeholder='e.g. When a lead is qualified, notify the team and send a follow-up in 60 min'
            required
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" type="submit">
            Compile to workflow
          </button>
          {preview && (
            <button className="btn btn-primary" type="button" onClick={() => void saveNlRule()}>
              Save inactive rule
            </button>
          )}
        </div>
        {preview && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {preview.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.label}</span>
                {s.gated ? " · needs approval" : ""}
                {s.detail ? <span className="text-[var(--muted)]"> — {s.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </form>

      <form className="surface flex flex-wrap gap-3 p-4" onSubmit={createRule}>
        <label className="min-w-48 flex-1 text-sm">
          Rule name
          <input
            className="input mt-1 w-full"
            placeholder="Rule name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          Trigger type
          <input
            className="input mt-1"
            placeholder="Trigger type"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          Action type
          <input
            className="input mt-1"
            placeholder="Action type"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            required
          />
        </label>
        <div className="flex items-end">
          <button className="btn btn-primary" type="submit">
            Create rule
          </button>
        </div>
      </form>

      {approvals.filter((a) => a.status === "PENDING").length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Pending approvals</h2>
          {approvals
            .filter((a) => a.status === "PENDING")
            .map((a) => (
              <article key={a.id} className="surface flex flex-wrap items-center gap-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.title}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {a.kind}
                    {a.automationRule?.name ? ` · ${a.automationRule.name}` : ""}
                  </p>
                </div>
                <button className="btn btn-primary" type="button" onClick={() => void decide(a.id, "APPROVED")}>
                  Approve
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => void decide(a.id, "REJECTED")}>
                  Reject
                </button>
              </article>
            ))}
        </section>
      )}

      <div className="grid gap-3">
        {rules.map((rule) => (
          <article key={rule.id} className="surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{rule.name}</h2>
              <span className="badge">{rule.triggerType}</span>
              <span className={rule.isActive ? "badge badge-success" : "badge"}>
                {rule.isActive ? "Active" : "Inactive"}
              </span>
              {rule.requiresApproval ? <span className="badge">Approval gated</span> : null}
              <button className="btn btn-secondary ml-auto" type="button" onClick={() => toggle(rule)}>
                {rule.isActive ? "Disable" : "Enable"}
              </button>
            </div>
            <p className="mt-3 text-sm text-[var(--muted)]">
              Trigger: {rule.triggerType}. Actions: {summarizeActions(rule.actions)}.
            </p>
            {Array.isArray(rule.workflow?.steps) && rule.workflow!.steps!.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-[var(--muted)]">
                {rule.workflow!.steps!.map((s) => (
                  <li key={s.id}>
                    {s.label}
                    {s.gated ? " (approval)" : ""}
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-xs text-[var(--muted)]">
              Recent executions: {rule.executions.length}
            </p>
          </article>
        ))}
        {rules.length === 0 && (
          <EmptyState
            title="No automations yet"
            body="Compile a natural-language rule into a visible workflow, review it, then enable. Or start with Autopilot for DM handling."
            actionHref="/autopilot"
            actionLabel="Open Autopilot"
          />
        )}
      </div>
    </div>
  );
}
