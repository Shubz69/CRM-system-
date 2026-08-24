"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

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

  return (
    <div className="space-y-8">
      <PageHeader
        description="Organisational goals and KPI targets — progress from durable snapshots, never invented scores."
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Create goal</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="input"
            placeholder="Goal name"
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
                toast.success("Goal created (DRAFT)");
                setName("");
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Create
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Add KPI definition</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            className="input"
            placeholder="KPI key"
            value={kpiKey}
            onChange={(e) => setKpiKey(e.target.value)}
          />
          <select
            className="input"
            value={calcKey}
            onChange={(e) => setCalcKey(e.target.value)}
          >
            {calculators.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key} ({c.unit})
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
                    key: kpiKey,
                    name: calc.description,
                    unit: calc.unit,
                    calculatorKey: calc.key,
                  }),
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || "KPI create failed");
                toast.success("KPI definition created");
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Create KPI
          </button>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Goals</h2>
        {goals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No goals yet.</p>
        ) : (
          goals.map((g) => (
            <div key={g.id} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">{g.name}</h3>
                <span className="text-xs uppercase tracking-wide">{g.status}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {g.category} · priority {g.priority}
              </p>
              {g.kpiTargets.length === 0 ? (
                <p className="text-sm">No KPI targets attached.</p>
              ) : (
                <ul className="text-sm list-disc pl-5">
                  {g.kpiTargets.map((t) => (
                    <li key={t.id}>
                      {t.kpiDefinition.name}: target {t.targetValue} {t.unit}
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
