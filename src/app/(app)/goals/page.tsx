"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import {
  currencyOfUnit,
  formatKpiValue,
  kpiInputAffix,
  kpiInputToStored,
  kpiStoredToInput,
  kpiLabel,
  statusLabel,
  unitLabel,
} from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { useCan } from "@/hooks/use-can";

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
  // Every goal change goes through POST /api/goals, which needs agent:manage.
  const canManage = useCan("agent:manage");
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [calculators, setCalculators] = useState<Calculator[]>([]);
  const [mainCurrency, setMainCurrency] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kpiKey, setKpiKey] = useState("qualified_lead_count");
  const [calcKey, setCalcKey] = useState("qualified_lead_count");
  const [targetValue, setTargetValue] = useState("10");
  const [attachGoalId, setAttachGoalId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingTarget, setEditingTarget] = useState<{ id: string; unit: string; value: string } | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/goals");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load goals");
    setGoals(json.goals ?? []);
    setCalculators(json.calculators ?? []);
    setMainCurrency(typeof json.mainCurrency === "string" ? json.mainCurrency : null);
  }, []);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  const selectedCalc = calculators.find((c) => c.key === calcKey);
  const selectedAffix = kpiInputAffix(selectedCalc?.unit ?? "COUNT");

  async function transition(goalId: string, status: "ACTIVE" | "PAUSED", success: string) {
    try {
      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "transition", goalId, status }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not update the goal");
      toast.success(success);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the goal");
    }
  }

  async function saveTarget() {
    if (!editingTarget) return;
    const typed = Number(editingTarget.value);
    if (editingTarget.value.trim() === "" || !Number.isFinite(typed) || typed < 0) {
      toast.error("Enter a valid target value");
      return;
    }
    if (editingTarget.unit === "RATE" && typed > 100) {
      toast.error("Enter the rate as a percentage between 0 and 100");
      return;
    }
    setSavingTarget(true);
    try {
      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_target",
          targetId: editingTarget.id,
          // People type pounds / percent; the KPI stores pence / a 0–1 rate.
          targetValue: kpiInputToStored(typed, editingTarget.unit),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not update the target");
      toast.success("Target updated");
      setEditingTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the target");
    } finally {
      setSavingTarget(false);
    }
  }

  const active = goals.filter((g) => g.status === "ACTIVE" || g.status === "AT_RISK");
  const drafts = goals.filter((g) => g.status === "DRAFT");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        description="Set targets, attach KPIs, and track progress from real workspace data."
        actions={
          canManage ? (
            <button type="button" className="btn btn-primary" data-testid="new-goal" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Close" : "New goal"}
            </button>
          ) : (
            <span className="text-sm text-[var(--muted)]">View only — workspace owners and admins set goals.</span>
          )
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

      {showCreate && canManage ? (
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
              <span className="inline-flex items-center gap-1">
                {selectedAffix.prefix ? (
                  <span className="text-sm text-[var(--muted)]">{selectedAffix.prefix}</span>
                ) : null}
                <input
                  className="input w-28"
                  type="number"
                  min={0}
                  max={selectedCalc?.unit === "RATE" ? 100 : undefined}
                  step="any"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  aria-label={
                    selectedCalc?.unit === "RATE"
                      ? "Target value (percent)"
                      : selectedAffix.prefix
                        ? `Target value (${selectedAffix.prefix})`
                        : "Target value"
                  }
                  placeholder="Target"
                />
                {selectedAffix.suffix ? (
                  <span className="text-sm text-[var(--muted)]">{selectedAffix.suffix}</span>
                ) : null}
              </span>
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
                  const typed = Number(targetValue);
                  if (targetValue.trim() === "" || !Number.isFinite(typed) || typed < 0) {
                    toast.error("Enter a valid target value");
                    return;
                  }
                  if (calc.unit === "RATE" && typed > 100) {
                    toast.error("Enter the rate as a percentage between 0 and 100");
                    return;
                  }
                  // People type pounds / percent; the KPI stores pence / a 0–1 rate.
                  const target = kpiInputToStored(typed, calc.unit);
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
            {selectedCalc ? (
              <p className="mt-2 text-xs text-[var(--muted)]">{selectedCalc.description}</p>
            ) : null}
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
            {canManage ? (
              <button
                type="button"
                className="btn btn-primary mt-5"
                onClick={() => setShowCreate(true)}
              >
                Create your first goal
              </button>
            ) : (
              <p className="mt-5 text-sm text-[var(--muted)]">
                Ask a workspace owner or admin to set the first goal.
              </p>
            )}
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
                    <li
                      key={t.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2"
                    >
                      <span>
                        {kpiLabel(t.kpiDefinition.name) || t.kpiDefinition.name}: target
                      </span>
                      {editingTarget?.id === t.id && canManage ? (
                        <form
                          className="flex flex-wrap items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void saveTarget();
                          }}
                        >
                          {kpiInputAffix(t.unit).prefix ? (
                            <span className="text-[var(--muted)]">{kpiInputAffix(t.unit).prefix}</span>
                          ) : null}
                          <input
                            className="input w-28"
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            aria-label="New target value"
                            value={editingTarget.value}
                            onChange={(e) => setEditingTarget({ ...editingTarget, value: e.target.value })}
                            autoFocus
                          />
                          {kpiInputAffix(t.unit).suffix ? (
                            <span className="text-[var(--muted)]">{kpiInputAffix(t.unit).suffix}</span>
                          ) : null}
                          <button className="btn btn-primary" type="submit" disabled={savingTarget}>
                            {savingTarget ? "Saving…" : "Save"}
                          </button>
                          <button
                            className="btn btn-secondary"
                            type="button"
                            disabled={savingTarget}
                            onClick={() => setEditingTarget(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <span className="font-medium">{formatKpiValue(t.targetValue, t.unit)}</span>
                          {currencyOfUnit(t.unit) &&
                          mainCurrency &&
                          currencyOfUnit(t.unit) !== mainCurrency ? (
                            <span className="text-xs text-[var(--muted)]">
                              Counts {currencyOfUnit(t.unit)} deals only — most of your deals are in{" "}
                              {mainCurrency}. Add a new target to track {mainCurrency}.
                            </span>
                          ) : null}
                          {canManage ? (
                          <button
                            type="button"
                            className="text-[var(--accent)] hover:underline"
                            onClick={() =>
                              setEditingTarget({
                                id: t.id,
                                unit: t.unit,
                                value: String(kpiStoredToInput(t.targetValue, t.unit)),
                              })
                            }
                          >
                            Edit
                          </button>
                          ) : null}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className={canManage ? "flex flex-wrap gap-2" : "hidden"}>
                {g.status === "DRAFT" && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => void transition(g.id, "ACTIVE", "Goal activated")}
                  >
                    Activate
                  </button>
                )}
                {(g.status === "ACTIVE" || g.status === "AT_RISK") && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => void transition(g.id, "PAUSED", "Goal paused")}
                  >
                    Pause
                  </button>
                )}
                {g.status === "PAUSED" && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => void transition(g.id, "ACTIVE", "Goal resumed")}
                  >
                    Resume
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
