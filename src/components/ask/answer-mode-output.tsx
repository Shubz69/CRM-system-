"use client";

import type { ReactNode } from "react";
import {
  isModeShapedOutput,
  type AnswerModeOutput,
} from "@/services/answer-modes/shape";

type Props = {
  output: unknown;
  /** Legacy fallback renderer when output is not mode-shaped. */
  fallback: ReactNode;
  onCapability?: (label: string) => void;
};

function EvidenceList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
      {items.map((item, i) => (
        <li key={`${item.slice(0, 40)}-${i}`}>{item}</li>
      ))}
    </ul>
  );
}

function QuickRenderer({ output }: { output: Extract<AnswerModeOutput, { mode: "quick" }> }) {
  return (
    <div className="whitespace-pre-wrap text-lg leading-relaxed text-[var(--foreground)]">
      {output.answer}
    </div>
  );
}

function ExecutiveRenderer({
  output,
}: {
  output: Extract<AnswerModeOutput, { mode: "executive" }>;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          Key finding
        </p>
        <p className="mt-1 text-lg font-medium leading-relaxed text-[var(--foreground)]">
          {output.keyFinding}
        </p>
      </div>
      {output.whatMatters ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            What matters
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--foreground)]">{output.whatMatters}</p>
        </div>
      ) : null}
      {output.evidence?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Evidence
          </p>
          <div className="mt-1">
            <EvidenceList items={output.evidence} />
          </div>
        </div>
      ) : null}
      {output.risks?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Risks</p>
          <div className="mt-1">
            <EvidenceList items={output.risks} />
          </div>
        </div>
      ) : null}
      {output.recommendation ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Recommendation
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--foreground)]">{output.recommendation}</p>
        </div>
      ) : null}
    </div>
  );
}

function ActionRenderer({
  output,
  onCapability,
}: {
  output: Extract<AnswerModeOutput, { mode: "action" }>;
  onCapability?: (label: string) => void;
}) {
  const capabilityLabel: Record<string, string> = {
    create_opportunity: "Create opportunity",
    create_task: "Create task",
    create_mission: "Create mission",
    draft_content: "Draft content",
    prepare_outreach: "Prepare outreach",
    save_research: "Save research",
    update_business_state: "Update business state",
  };

  return (
    <div className="space-y-4">
      {output.summary ? (
        <p className="text-sm leading-relaxed text-[var(--muted)]">{output.summary}</p>
      ) : null}
      <ol className="space-y-3">
        {output.actions.map((action, i) => (
          <li key={`${action.what}-${i}`} className="surface p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-medium text-[var(--muted)]">
                {action.order ?? i + 1}.
              </span>
              <p className="font-medium text-[var(--foreground)]">{action.what}</p>
            </div>
            {action.why ? (
              <p className="mt-1 text-sm text-[var(--muted)]">{action.why}</p>
            ) : null}
            {action.risks?.length ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                Risks: {action.risks.join(" · ")}
              </p>
            ) : null}
            {action.agentDeskCapability ? (
              <button
                type="button"
                className="btn btn-secondary mt-3 text-sm"
                onClick={() =>
                  onCapability?.(
                    capabilityLabel[action.agentDeskCapability!] ||
                      action.agentDeskCapability!,
                  )
                }
              >
                {capabilityLabel[action.agentDeskCapability] || action.agentDeskCapability}
                {action.approvalRequestId ? " (awaiting approval)" : " — propose"}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="text-xs text-[var(--muted)]">
        Capability buttons send a proposal for approval — they never run automatically.
      </p>
    </div>
  );
}

function DeepRenderer({
  output,
  onCapability,
}: {
  output: Extract<AnswerModeOutput, { mode: "deep" }>;
  onCapability?: (label: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          Executive summary
        </p>
        <p className="mt-1 text-base leading-relaxed text-[var(--foreground)]">
          {output.executiveSummary}
        </p>
      </div>
      {output.method ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Method</p>
          <p className="mt-1 text-sm text-[var(--muted)]">{output.method}</p>
        </div>
      ) : null}
      {output.findings?.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Findings
          </p>
          <ul className="space-y-3">
            {output.findings.map((f, i) => (
              <li key={`${f.claim}-${i}`} className="surface p-4">
                <p className="text-[var(--foreground)]">{f.claim}</p>
                {f.evidenceExcerpt ? (
                  <p className="mt-2 text-sm text-[var(--muted)]">{f.evidenceExcerpt}</p>
                ) : null}
                {f.sourceUrl ? (
                  <a
                    href={f.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline"
                  >
                    Source
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {output.evidence?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Evidence
          </p>
          <div className="mt-1">
            <EvidenceList items={output.evidence} />
          </div>
        </div>
      ) : null}
      {output.sources?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Sources
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {output.sources.map((s, i) => (
              <li key={`${s.url}-${i}`}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  {s.title || s.url}
                </a>
                {s.platform ? (
                  <span className="ml-2 text-xs text-[var(--muted)]">{s.platform}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {output.contradictions?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Contradictions
          </p>
          <EvidenceList items={output.contradictions} />
        </div>
      ) : null}
      {output.unknowns?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Unknowns
          </p>
          <EvidenceList items={output.unknowns} />
        </div>
      ) : null}
      {output.caveats?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Caveats
          </p>
          <EvidenceList items={output.caveats} />
        </div>
      ) : null}
      {output.businessImplications ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Business implications
          </p>
          <p className="mt-1 text-sm leading-relaxed">{output.businessImplications}</p>
        </div>
      ) : null}
      {output.marketImplications ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Market implications
          </p>
          <p className="mt-1 text-sm leading-relaxed">{output.marketImplications}</p>
        </div>
      ) : null}
      {output.recommendations?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Recommendations
          </p>
          <EvidenceList items={output.recommendations} />
        </div>
      ) : null}
      {output.capabilityProposals?.length ? (
        <div className="flex flex-wrap gap-2">
          {output.capabilityProposals.map((p) => (
            <button
              key={p.approvalRequestId || p.label}
              type="button"
              className="btn btn-secondary text-sm"
              onClick={() => onCapability?.(p.label)}
            >
              {p.label}
              {p.approvalRequestId ? " (awaiting approval)" : ""}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mode-specific Ask/Research output renderer with graceful legacy fallback.
 */
export function AnswerModeOutputView({ output, fallback, onCapability }: Props) {
  if (!isModeShapedOutput(output)) {
    return <>{fallback}</>;
  }

  switch (output.mode) {
    case "quick":
      return <QuickRenderer output={output} />;
    case "executive":
      return <ExecutiveRenderer output={output} />;
    case "action":
      return <ActionRenderer output={output} onCapability={onCapability} />;
    case "deep":
      return <DeepRenderer output={output} onCapability={onCapability} />;
    default:
      return <>{fallback}</>;
  }
}

/** Shared helper for tests / SSR checks — re-export. */
export { isModeShapedOutput };
