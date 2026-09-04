"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { WorkflowViewer } from "@/components/automations/workflow-viewer";
import {
  AUTOMATION_ACTION_OPTIONS,
  AUTOMATION_TRIGGER_OPTIONS,
  automationActionLabel,
  automationTriggerLabel,
} from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

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
  if (!Array.isArray(actions) || actions.length === 0) return "none yet";
  return actions
    .map((action) => {
      if (action && typeof action === "object" && "type" in action) {
        return automationActionLabel(String((action as { type: unknown }).type));
      }
      return "unknown action";
    })
    .join("; ");
}

export default function AutomationsPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("lead_qualified");
  const [actionType, setActionType] = useState("send_follow_up");
  const [nl, setNl] = useState("");
  const [preview, setPreview] = useState<WorkflowStep[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function load() {
    setListState("loading");
    const [rulesRes, approvalsRes] = await Promise.all([
      fetch("/api/automations"),
      fetch("/api/approvals"),
    ]);
    const rulesJson = await rulesRes.json();
    if (!rulesRes.ok) {
      setListState("error");
      throw new Error(rulesJson.error || "Failed");
    }
    setRules(rulesJson.rules);
    if (approvalsRes.ok) {
      const a = await approvalsRes.json();
      setApprovals(a.approvals ?? []);
    }
    setListState("ready");
  }

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, []);

  async function createRule(event: FormEvent) {
    event.preventDefault();
    const response = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, triggerType, actions: [{ type: actionType }] }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    setName("");
    setShowAdvanced(false);
    await load();
    toast.success("Rule created");
  }

  async function compileNl(event: FormEvent) {
    event.preventDefault();
    const response = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "compile", naturalLanguage: nl }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Compile failed");
    setPreview(json.workflow?.steps ?? []);
    toast.success("Workflow ready to review — not enabled yet");
  }

  async function saveNlRule() {
    const response = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_from_nl",
        name: name || "Automation from description",
        naturalLanguage: nl,
      }),
    });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    toast.success("Saved inactive — review, then enable");
    setNl("");
    setPreview(null);
    await load();
  }

  async function toggle(rule: Rule) {
    const response = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/automations", {
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

  const pending = approvals.filter((a) => a.status === "PENDING");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        description="Describe what should happen — Agent Desk turns it into a readable workflow you can enable safely."
        actions={
          <div className="flex flex-wrap gap-2">
            <a href="/approvals" className="btn btn-secondary">
              Approvals
            </a>
            <a href="/autopilot" className="btn btn-secondary">
              Autopilot
            </a>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="surface p-4">
          <p className="caption">Live</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">
            {rules.filter((r) => r.isActive).length}
          </p>
        </div>
        <div className="surface p-4">
          <p className="caption">Pending approval</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">{pending.length}</p>
        </div>
        <div className="surface p-4">
          <p className="caption">Total rules</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">{rules.length}</p>
        </div>
      </div>

      <form className="surface-primary space-y-3 p-5" onSubmit={compileNl}>
        <label className="block text-sm font-medium">
          Describe what should happen
          <textarea
            className="input mt-2 min-h-28 w-full"
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            placeholder="When a qualified lead arrives, wait 30 minutes and send a follow-up."
            required
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit">
            Build automation
          </button>
          {preview && (
            <button className="btn btn-secondary" type="button" onClick={() => void saveNlRule()}>
              Save inactive rule
            </button>
          )}
        </div>
        {preview && (
          <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
            <p className="caption mb-3">Readable workflow</p>
            <WorkflowViewer steps={preview} title="When → Wait → Then" />
          </div>
        )}
      </form>

      <details
        className="surface-muted p-4"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-sm font-medium">Advanced: build from fields</summary>
        <form className="mt-4 flex flex-wrap gap-3" onSubmit={createRule}>
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
            When
            <select
              className="input mt-1"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              required
            >
              {AUTOMATION_TRIGGER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Then
            <select
              className="input mt-1"
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              required
            >
              {AUTOMATION_ACTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button className="btn btn-secondary" type="submit">
              Create rule
            </button>
          </div>
        </form>
      </details>

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Pending approvals</h2>
          {pending.map((a) => (
            <article key={a.id} className="surface-attention flex flex-wrap items-center gap-2 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a.title}</p>
                <p className="text-xs text-[var(--muted)]">
                  {a.automationRule?.name ? a.automationRule.name : "Automation approval"}
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
              <span className="badge">{automationTriggerLabel(rule.triggerType)}</span>
              <span className={rule.isActive ? "badge badge-success" : "badge"}>
                {rule.isActive ? "Active" : "Inactive"}
              </span>
              {rule.requiresApproval ? <span className="badge">Needs approval</span> : null}
              <button className="btn btn-secondary ml-auto" type="button" onClick={() => toggle(rule)}>
                {rule.isActive ? "Disable" : "Enable"}
              </button>
            </div>
            <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-[var(--surface-muted)] p-3">
                <p className="caption">When</p>
                <p className="mt-1 font-medium">{automationTriggerLabel(rule.triggerType)}</p>
              </div>
              <div className="rounded-lg bg-[var(--surface-muted)] p-3 sm:col-span-2">
                <p className="caption">Then</p>
                <p className="mt-1 font-medium">{summarizeActions(rule.actions)}</p>
              </div>
            </div>
            {Array.isArray(rule.workflow?.steps) && rule.workflow!.steps!.length > 0 && (
              <div className="mt-3">
                <WorkflowViewer steps={rule.workflow!.steps!} title="Workflow" />
              </div>
            )}
            <p className="mt-2 text-xs text-[var(--muted)]">
              Recent runs: {rule.executions.length}
            </p>
          </article>
        ))}
        {listState === "loading" && (
          <p className="p-4 text-sm text-[var(--muted)]">Loading automations…</p>
        )}
        {listState === "error" && (
          <p className="p-4 text-sm text-[var(--danger)]">Could not load automations.</p>
        )}
        {listState === "ready" && rules.length === 0 && (
          <EmptyState
            title="No automations yet"
            body="Describe a follow-up or handoff in plain language, review the workflow, then enable."
            actionHref="/autopilot"
            actionLabel="Open Autopilot"
          />
        )}
      </div>
    </div>
  );
}
