"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { formatKpiValue, kpiLabel, statusLabel, unitLabel } from "@/lib/customer-labels";

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
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [calculators, setCalculators] = useState<Calculator[]>([]);
  const [name, setName] = useState("");
  const [kpiKey, setKpiKey] = useState("open_pipeline");
  const [calcKey, setCalcKey] = useState("open_pipeline_cents");
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/goals");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load goals");
    setGoals(json.goals ?? []);
    setCalculators(json.calculators ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  const active = goals.filter((g) => g.status === "ACTIVE" || g.status === "AT_RISK");
  const drafts = goals.filter((g) => g.status === "DRAFT");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        description="Set targets, attach KPIs, and track progress from real workspace data."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
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
                  const res = await fetch("/api/goals", {
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
            <h3 className="text-sm font-medium">Optional: attach a KPI</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              KPIs use real workspace numbers — never invented scores.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  const calc = calculators.find((c) => c.key === calcKey);
                  if (!calc) return;
                  try {
                    const res = await fetch("/api/goals", {
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
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || "KPI create failed");
                    toast.success("KPI added");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  }
                }}
              >
                Add KPI
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="font-[family-name:var(--font-fraunces)] text-xl">Your goals</h2>
        {goals.length === 0 ? (
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
                      const res = await fetch("/api/goals", {
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
                      const res = await fetch("/api/goals", {
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
