import Link from "next/link";

/** First-run empty state — always points at one useful next action. */
export function EmptyState({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="surface max-w-xl p-6">
      <p className="font-[family-name:var(--font-fraunces)] text-2xl text-[var(--foreground)]">
        {title}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{body}</p>
      <Link href={actionHref} className="btn btn-primary mt-5">
        {actionLabel}
      </Link>
    </div>
  );
}
