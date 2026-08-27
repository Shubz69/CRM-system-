export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-9 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
      <div className="skeleton h-40 w-full" />
      <div className="skeleton h-40 w-full" />
    </div>
  );
}

export function PageError({
  message,
  onRetry,
  detailId,
}: {
  message: string;
  onRetry?: () => void;
  /** Optional diagnostic id for support — shown as advanced detail only. */
  detailId?: string;
}) {
  return (
    <div className="surface max-w-xl p-6" role="alert">
      <p className="font-[family-name:var(--font-fraunces)] text-2xl">Something went wrong</p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{message}</p>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Your data was not changed. You can try again, or continue elsewhere and return later.
      </p>
      {onRetry ? (
        <button type="button" className="btn btn-primary mt-5" onClick={onRetry}>
          Try again
        </button>
      ) : null}
      {detailId ? (
        <p className="mt-4 text-xs text-[var(--muted)]">
          Reference: <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5">{detailId}</code>
        </p>
      ) : null}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <span className="sr-only">Loading table</span>
      <div className="skeleton h-10 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-12 w-full" />
      ))}
    </div>
  );
}
