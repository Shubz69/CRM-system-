import type { ReactNode } from "react";

/** Page copy + actions. The app shell already owns the single H1. */
export function PageHeader({
  description,
  actions,
}: {
  description?: string;
  actions?: ReactNode;
}) {
  if (!description && !actions) return null;
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      {description ? (
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--muted)] md:text-base">
          {description}
        </p>
      ) : (
        <span />
      )}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
