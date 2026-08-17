export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-28 w-full" />
      <div className="skeleton h-28 w-full" />
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="surface max-w-xl p-6" role="alert">
      <p className="font-[family-name:var(--font-fraunces)] text-2xl">Something went wrong</p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-primary mt-5" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
