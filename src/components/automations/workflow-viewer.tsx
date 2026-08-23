"use client";

export type WorkflowStepView = {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  gated?: boolean;
};

const KIND_ACCENT: Record<string, string> = {
  trigger: "border-[var(--accent)] bg-[var(--accent)]/10",
  condition: "border-amber-500/50 bg-amber-500/5",
  logic: "border-[var(--border)] bg-[var(--surface-2)]",
  action: "border-emerald-600/40 bg-emerald-600/5",
  approval: "border-rose-500/50 bg-rose-500/5",
  outcome: "border-[var(--border)] bg-[var(--surface)]",
};

/**
 * Read-only visual workflow — shows compiled steps. Not a drag-drop builder.
 */
export function WorkflowViewer({
  steps,
  title = "Workflow",
}: {
  steps: WorkflowStepView[];
  title?: string;
}) {
  if (!steps.length) {
    return (
      <p className="text-sm text-[var(--muted)]">No workflow steps to display.</p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{title}</p>
      <ol className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch md:gap-0">
        {steps.map((step, index) => (
          <li key={step.id} className="flex min-w-0 md:max-w-[12rem] md:flex-1">
            <div
              className={`w-full rounded-xl border px-3 py-2.5 text-sm ${
                KIND_ACCENT[step.kind] ?? KIND_ACCENT.logic
              }`}
            >
              <p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {index + 1}. {step.kind}
                {step.gated ? " · gated" : ""}
              </p>
              <p className="mt-0.5 font-medium leading-snug text-[var(--foreground)]">{step.label}</p>
              {step.detail ? (
                <p className="mt-1 text-xs leading-snug text-[var(--muted)]">{step.detail}</p>
              ) : null}
            </div>
            {index < steps.length - 1 && (
              <span
                className="mx-1 hidden self-center text-[var(--muted)] md:inline"
                aria-hidden
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-[var(--muted)]">
        Read-only view of the compiled workflow. Re-compile from natural language to change steps
        (drag-drop builder deferred).
      </p>
    </div>
  );
}
