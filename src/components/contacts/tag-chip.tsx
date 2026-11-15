"use client";

/** A tag as a small chip: colour dot + name, optional remove button. */
export function TagChip({
  name,
  color,
  onRemove,
  removing,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
  removing?: boolean;
}) {
  return (
    <span
      className="badge gap-1.5 text-[var(--foreground)]"
      style={{ background: `color-mix(in oklab, ${color} 14%, white)` }}
    >
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {name}
      {onRemove ? (
        <button
          type="button"
          className="-mr-1 ml-0.5 rounded px-1 leading-none text-[var(--muted)] hover:text-[var(--danger)] disabled:opacity-50"
          aria-label={`Remove tag ${name}`}
          title={`Remove ${name}`}
          disabled={removing}
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export const TAG_COLORS = [
  "#64748b",
  "#0c6b64",
  "#1e3a5f",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#e11d48",
  "#ea580c",
  "#b45309",
  "#16a34a",
];
