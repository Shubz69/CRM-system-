"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

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

export default function AutomationsPage() {
  const [rules, setRules] = useState<Rule[]>([]);

  useEffect(() => {
    fetch("/api/automations")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setRules(j.rules);
      })
      .catch((e) => toast.error(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Automations</h1>
        <p className="text-[var(--muted)]">
          Rules are executed by background workers — not browser timers.
        </p>
      </div>
      <div className="grid gap-3">
        {rules.map((rule) => (
          <article key={rule.id} className="surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{rule.name}</h2>
              <span className="badge">{rule.triggerType}</span>
              <span className={rule.isActive ? "badge badge-success" : "badge"}>
                {rule.isActive ? "Active" : "Inactive"}
              </span>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--surface-2)] p-3 text-xs">
              {JSON.stringify({ conditions: rule.conditions, actions: rule.actions }, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Recent executions: {rule.executions.length}
            </p>
          </article>
        ))}
        {rules.length === 0 && <div className="surface p-6 text-[var(--muted)]">No rules yet.</div>}
      </div>
    </div>
  );
}
