import type { VisibleFinding, VisibleSource } from "@/lib/research-visible-evidence";

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function ResearchFindingCards({
  findings,
}: {
  findings: Array<VisibleFinding | {
    claim: string;
    sourceUrl?: string;
    evidenceExcerpt?: string;
    sourceTitle?: string;
  }>;
}) {
  if (!findings.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        Findings
      </p>
      <ul className="space-y-3">
        {findings.map((f, i) => (
          <li key={`${f.claim}-${i}`} className="surface p-4">
            <p className="text-[var(--foreground)]">{f.claim}</p>
            {f.evidenceExcerpt ? (
              <p className="mt-2 text-sm text-[var(--muted)]">“{f.evidenceExcerpt}”</p>
            ) : null}
            {f.sourceUrl ? (
              <p className="mt-2 text-sm">
                <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
                  Source
                </span>{" "}
                <a
                  href={f.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] hover:underline break-all"
                >
                  {f.sourceTitle || domainFromUrl(f.sourceUrl) || f.sourceUrl}
                </a>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResearchSourceCards({
  sources,
}: {
  sources: Array<
    VisibleSource | {
      url: string;
      title?: string | null;
      snippet?: string | null;
      author?: string | null;
      platform?: string | null;
    }
  >;
}) {
  if (!sources.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        Sources ({sources.length})
      </p>
      <ul className="space-y-3">
        {sources.map((s, i) => (
          <li key={`${s.url}-${i}`} className="rounded-xl border border-[var(--border)] px-4 py-3">
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--accent)] hover:underline"
            >
              {s.title || s.url}
            </a>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              {[s.platform, s.author, domainFromUrl(s.url)].filter(Boolean).join(" · ")}
            </p>
            {s.snippet ? (
              <p className="mt-2 text-sm text-[var(--muted)]">“{s.snippet}”</p>
            ) : null}
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block break-all text-xs text-[var(--accent)] hover:underline"
            >
              {s.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
