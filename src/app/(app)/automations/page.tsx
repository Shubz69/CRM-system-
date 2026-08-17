"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

type Rule = {
  id: string;
  name: string;
  description: string | null;
  triggerType: string;
  isActive: boolean;
  conditions: unknown;
  actions: unknown;
  executions: Array<{ id: string; status: string; createdAt: string }>;
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
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("lead_created");
  const [actionType, setActionType] = useState("send_follow_up");

  async function load() {
    const response = await fetch("/api/automations");
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed");
    setRules(json.rules);
  }

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, []);

  async function createRule(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, triggerType, actions: [{ type: actionType }] }) });
    const json = await response.json();
    if (!response.ok) return toast.error(json.error || "Failed");
    setName(""); await load(); toast.success("Rule created");
  }

  async function toggle(rule: Rule) {
    const response = await fetch("/api/automations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }) });
    if (!response.ok) return toast.error("Unable to update rule");
    await load();
  }

  return (
    <div className="space-y-6">
      <PageHeader description="Rules are executed by background workers — not browser timers." />
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
      <div className="grid gap-3">
        {rules.map((rule) => (
          <article key={rule.id} className="surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{rule.name}</h2>
              <span className="badge">{rule.triggerType}</span>
              <span className={rule.isActive ? "badge badge-success" : "badge"}>
                {rule.isActive ? "Active" : "Inactive"}
              </span>
              <button className="btn btn-secondary ml-auto" type="button" onClick={() => toggle(rule)}>
                {rule.isActive ? "Disable" : "Enable"}
              </button>
            </div>
            <p className="mt-3 text-sm text-[var(--muted)]">
              Trigger: {rule.triggerType}. Actions: {summarizeActions(rule.actions)}.
            </p>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Recent executions: {rule.executions.length}
            </p>
          </article>
        ))}
        {rules.length === 0 && (
          <EmptyState
            title="No automations yet"
            body="Automations move leads and send follow-ups without you watching the inbox. Start with Autopilot if you just want DMs handled."
            actionHref="/autopilot"
            actionLabel="Open Autopilot"
          />
        )}
      </div>
    </div>
  );
}
