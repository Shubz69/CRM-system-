import Link from "next/link";

export type EmptyStateAction = {
  href: string;
  label: string;
  primary?: boolean;
};

/** First-run / empty surface with clear next actions. */
export function EmptyState({
  title,
  body,
  actionHref,
  actionLabel,
  actions,
}: {
  title: string;
  body: string;
  /** @deprecated Prefer `actions` */
  actionHref?: string;
  actionLabel?: string;
  actions?: EmptyStateAction[];
}) {
  const resolved: EmptyStateAction[] =
    actions && actions.length > 0
      ? actions.slice(0, 5)
      : actionHref && actionLabel
        ? [{ href: actionHref, label: actionLabel, primary: true }]
        : [];

  return (
    <div className="surface max-w-xl p-6 md:p-8">
      <p className="font-[family-name:var(--font-fraunces)] text-2xl text-[var(--foreground)]">
        {title}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{body}</p>
      {resolved.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {resolved.map((action, index) => (
            <Link
              key={action.href}
              href={action.href}
              className={
                action.primary || index === 0 ? "btn btn-primary" : "btn btn-secondary"
              }
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
