"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { formatKpiValue, kpiLabel, statusLabel, unitLabel } from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type GoalRow = {
  id: string;
  name: string;
  status: string;
  category: string;
  priority: number;
  kpiTargets: Array<{
    id: string;
    targetValue: number;
    unit: string;
    kpiDefinition: { id: string; name: string; unit: string };
  }>;
};

type Calculator = { key: string; unit: string; description: string };

export default function GoalsPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [calculators, setCalculators] = useState<Calculator[]>([]);
  const [name, setName] = useState("");
  const [kpiKey, setKpiKey] = useState("qualified_lead_count");
  const [calcKey, setCalcKey] = useState("qualified_lead_count");
  const [targetValue, setTargetValue] = useState("10");
  const [attachGoalId, setAttachGoalId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/goals");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load goals");
    setGoals(json.goals ?? []);
    setCalculators(json.calculators ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  const active = goals.filter((g) => g.status === "ACTIVE" || g.status === "AT_RISK");
  const drafts = goals.filter((g) => g.status === "DRAFT");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        description="Set targets, attach KPIs, and track progress from real workspace data."
        actions={
          <button type="button" className="btn btn-primary" data-testid="new-goal" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : "New goal"}
          </button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="surface p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">Active</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">{active.length}</p>
        </div>
        <div className="surface p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">Drafts</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">{drafts.length}</p>
        </div>
        <div className="surface p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">KPI targets</p>
          <p className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl">
            {goals.reduce((n, g) => n + g.kpiTargets.length, 0)}
          </p>
        </div>
      </div>

      {showCreate ? (
        <section className="surface space-y-5 p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Create a goal</h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="input min-w-[16rem] flex-1"
              placeholder="e.g. Book 20 qualified meetings this quarter"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="btn btn-primary"
              type="button"
              onClick={async () => {
                try {
                  const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "create_goal", name }),
                  });
                  const json = await res.json();
                  if (!res.ok) throw new Error(json.error || "Create failed");
                  toast.success("Goal created as draft");
                  setName("");
                  setShowCreate(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                }
              }}
            >
              Create draft
            </button>
          </div>

          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-medium">Attach a KPI target to a goal</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Creates the KPI definition and attaches a numeric target — both required for a
              complete save.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="input min-w-[12rem]"
                value={attachGoalId}
                onChange={(e) => setAttachGoalId(e.target.value)}
                aria-label="Goal for KPI"
              >
                <option value="">Select goal…</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <select
                className="input min-w-[14rem]"
                value={calcKey}
                onChange={(e) => {
                  const key = e.target.value;
                  setCalcKey(key);
                  setKpiKey(key);
                }}
                aria-label="KPI measure"
              >
                {calculators.map((c) => (
                  <option key={c.key} value={c.key}>
                    {kpiLabel(c.key)} ({unitLabel(c.unit)})
                  </option>
                ))}
              </select>
              <input
                className="input w-28"
                type="number"
                min={0}
                step="any"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                aria-label="Target value"
                placeholder="Target"
              />
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  const calc = calculators.find((c) => c.key === calcKey);
                  if (!calc) return;
                  if (!attachGoalId) {
                    toast.error("Select a goal before attaching a KPI target");
                    return;
                  }
                  const target = Number(targetValue);
                  if (!Number.isFinite(target) || target < 0) {
                    toast.error("Enter a valid target value");
                    return;
                  }
                  try {
                    const createRes = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "create_kpi",
                        key: kpiKey || calc.key,
                        name: kpiLabel(calc.key),
                        unit: calc.unit,
                        calculatorKey: calc.key,
                      }),
                    });
                    const createJson = await createRes.json();
                    if (!createRes.ok) {
                      throw new Error(createJson.error || "KPI create failed");
                    }
                    const kpiId = createJson.kpi?.id as string | undefined;
                    if (!kpiId) throw new Error("KPI created without an id");
                    const attachRes = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "attach_target",
                        goalId: attachGoalId,
                        kpiDefinitionId: kpiId,
                        targetValue: target,
                        unit: calc.unit,
                      }),
                    });
                    const attachJson = await attachRes.json();
                    if (!attachRes.ok) {
                      throw new Error(
                        attachJson.error ||
                          "KPI created but target was not attached — open the goal and retry",
                      );
                    }
                    toast.success("KPI target attached to goal");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  }
                }}
              >
                Add KPI target
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="font-[family-name:var(--font-fraunces)] text-xl">Your goals</h2>
        {loading ? (
          <div className="surface p-6" role="status" aria-live="polite">
            <p className="text-sm text-[var(--muted)]">Loading goals…</p>
          </div>
        ) : goals.length === 0 ? (
          <div className="surface max-w-xl p-6 md:p-8">
            <p className="font-[family-name:var(--font-fraunces)] text-2xl text-[var(--foreground)]">
              No goals yet
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
              Define what success looks like — meetings booked, pipeline value, or reply speed —
              then attach KPIs.
            </p>
            <button
              type="button"
              className="btn btn-primary mt-5"
              onClick={() => setShowCreate(true)}
            >
              Create your first goal
            </button>
          </div>
        ) : (
          goals.map((g) => (
            <div key={g.id} className="surface space-y-3 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium text-[var(--foreground)]">{g.name}</h3>
                <span className="badge">{statusLabel(g.status)}</span>
              </div>
              <p className="text-sm text-[var(--muted)]">
                {g.category} · priority {g.priority}
              </p>
              {g.kpiTargets.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No KPI targets attached yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {g.kpiTargets.map((t) => (
                    <li key={t.id} className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
                      {kpiLabel(t.kpiDefinition.name) || t.kpiDefinition.name}: target{" "}
                      {formatKpiValue(t.targetValue, t.unit)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {g.status === "DRAFT" && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={async () => {
                      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "transition",
                          goalId: g.id,
                          status: "ACTIVE",
                        }),
                      });
                      const json = await res.json();
                      if (!res.ok) toast.error(json.error || "Failed");
                      else {
                        toast.success("Goal activated");
                        await load();
                      }
                    }}
                  >
                    Activate
                  </button>
                )}
                {(g.status === "ACTIVE" || g.status === "AT_RISK") && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={async () => {
                      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "transition",
                          goalId: g.id,
                          status: "PAUSED",
                        }),
                      });
                      const json = await res.json();
                      if (!res.ok) toast.error(json.error || "Failed");
                      else await load();
                    }}
                  >
                    Pause
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
