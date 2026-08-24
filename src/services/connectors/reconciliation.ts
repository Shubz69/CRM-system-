/**
 * External action reconciliation contract — feeds MissionExternalOutcome.
 * Do not fake reconciliation where the provider cannot support it.
 */

import type { ReconciliationSupport } from "@/services/connectors/types";
import { getConnectorDefinition } from "@/services/connectors/catalogue";

export type ReconciliationPlan = {
  operation: string;
  providerKey: string;
  support: ReconciliationSupport;
  steps: Array<"prepare" | "dispatch" | "lookup" | "confirm">;
  notes: string;
};

export function getReconciliationPlan(
  providerKey: string,
  operationName: string,
): ReconciliationPlan | null {
  const def = getConnectorDefinition(providerKey);
  if (!def) return null;
  const op = def.operations.find((o) => o.name === operationName);
  if (!op) return null;

  const support = op.providerIdempotency;
  const steps: ReconciliationPlan["steps"] =
    support === "lookup"
      ? ["prepare", "dispatch", "lookup", "confirm"]
      : support === "idempotency_key"
        ? ["prepare", "dispatch", "confirm"]
        : ["prepare", "dispatch"];

  return {
    operation: operationName,
    providerKey,
    support,
    steps,
    notes:
      support === "neither"
        ? "Provider offers neither idempotency key nor reliable lookup — MissionExternalOutcome must use RECONCILIATION_REQUIRED carefully; do not blind-replay CONFIRMED."
        : support === "lookup"
          ? "After DISPATCHING, crash recovery should lookup provider object before re-dispatch."
          : "Provider accepts idempotency key — reuse stable key on retry.",
  };
}

/**
 * Whether a CONFIRMED external outcome may be treated as terminal for this op.
 */
export function confirmedPreventsReplay(providerKey: string, operationName: string): boolean {
  const plan = getReconciliationPlan(providerKey, operationName);
  return Boolean(plan); // any declared consequential op: CONFIRMED must not replay
}
