"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ASK_SHOW_SOURCES_BY_DEFAULT } from "@/lib/ask-result-ui";
import {
  isModeShapedOutput,
  type AnswerModeOutput,
} from "@/services/answer-modes/shape";
import {
  hasCompleteTypedAnswers,
  resolveTypedAnswers,
  resolveVideoExamples,
  type AskTypedAnswers,
  type AskVideoExample,
} from "@/services/answer-modes/typed-answers";
import {
  ResearchFindingCards,
  ResearchSourceCards,
} from "@/components/research/evidence-cards";
import { workspaceFetch } from "@/lib/workspace-client";

function EvidenceToggle({
  findings,
  sources,
}: {
  findings?: Array<{
    claim: string;
    sourceUrl: string;
    evidenceExcerpt?: string;
    sourceTitle?: string;
  }>;
  sources?: Array<{
    url: string;
    title?: string;
    snippet?: string;
    author?: string;
    platform?: string;
  }>;
}) {
  const [open, setOpen] = useState(ASK_SHOW_SOURCES_BY_DEFAULT);
  if (!findings?.length && !sources?.length) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid="ask-evidence-toggle"
        className="text-xs font-medium uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide evidence" : "Show evidence"}
      </button>
      {open ? (
        <div data-testid="ask-evidence-open">
          <ResearchFindingCards findings={findings ?? []} />
          <ResearchSourceCards sources={sources ?? []} />
        </div>
      ) : null}
    </div>
  );
}

function TypedAnswersView({
  answers,
}: {
  answers: AskTypedAnswers;
}) {
  const sections = [answers.strategy, answers.scripts, answers.postingPlan, answers.monetization];
  return (
    <div className="space-y-4" data-testid="ask-typed-answers">
      {sections.map((section) => (
        <article
          key={section.type}
          data-testid={`ask-answer-${section.type}`}
          className="surface p-4"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            {section.title}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]">
            {section.body}
          </p>
          {section.bullets?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--foreground)]">
              {section.bullets.map((bullet, i) => (
                <li key={`${section.type}-${i}`}>{bullet}</li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function AskVideoExamples({ examples }: { examples: AskVideoExample[] }) {
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  if (!examples.length) return null;

  async function onGenerate(example: AskVideoExample, index: number) {
    setBusyIndex(index);
    try {
      const { getImmutableWorkspaceContext } = await import("@/lib/workspace-client");
      const ctx = getImmutableWorkspaceContext();
      const res = await workspaceFetch(
        ctx.loadedOrganisationId,
        ctx.workspaceRevision,
        "/api/ask/video-examples",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: example.title,
            hook: example.hook,
            shotList: example.shotList,
            lengthSeconds: example.lengthSeconds,
            platform: example.platform,
          }),
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        error?: string;
        url?: string;
      };
      if (!res.ok || !json.ok) {
        toast.error(json.error || "Video generation is not configured.");
        return;
      }
      toast.success("Example video is ready.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the example video.");
    } finally {
      setBusyIndex(null);
    }
  }

  const notConfiguredNote = examples.find((e) => e.userFacingMessage)?.userFacingMessage;

  return (
    <div className="space-y-3" data-testid="ask-video-examples">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        Example AI videos
      </p>
      {notConfiguredNote ? (
        <p className="text-sm text-[var(--muted)]" data-testid="ask-video-not-configured">
          {notConfiguredNote}
        </p>
      ) : null}
      <ul className="space-y-3">
        {examples.map((example, i) => (
          <li key={`${example.title}-${i}`} className="surface p-4">
            <p className="font-medium text-[var(--foreground)]">{example.title}</p>
            <p className="mt-1 text-xs uppercase tracking-wide text-[var(--muted)]">
              {example.platform} · {example.lengthSeconds}s
            </p>
            <p className="mt-2 text-sm text-[var(--foreground)]">
              <span className="font-medium">Hook:</span> {example.hook}
            </p>
            {example.shotList.length ? (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--muted)]">
                {example.shotList.map((shot, si) => (
                  <li key={`${example.title}-shot-${si}`}>{shot}</li>
                ))}
              </ol>
            ) : null}
            {example.url ? (
              <a
                href={example.url}
                className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline"
              >
                Open generated video
              </a>
            ) : (
              <button
                type="button"
                className="btn btn-secondary mt-3 text-sm"
                disabled={busyIndex === i}
                onClick={() => void onGenerate(example, i)}
              >
                {busyIndex === i ? "Checking…" : "Generate example video"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Props = {
  output: unknown;
  request?: string | null;
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

function CustomerResult({
  output,
  request,
  extras,
  findings,
  sources,
}: {
  output: unknown;
  request?: string | null;
  extras?: ReactNode;
  findings?: Array<{
    claim: string;
    sourceUrl: string;
    evidenceExcerpt?: string;
    sourceTitle?: string;
  }>;
  sources?: Array<{
    url: string;
    title?: string;
    snippet?: string;
    author?: string;
    platform?: string;
  }>;
}) {
  const answers = resolveTypedAnswers(output, request);
  const videos = resolveVideoExamples(output, request);
  return (
    <div className="space-y-5">
      <TypedAnswersView answers={answers} />
      <AskVideoExamples examples={videos} />
      {extras}
      <EvidenceToggle findings={findings} sources={sources} />
    </div>
  );
}

function QuickRenderer({
  output,
  request,
}: {
  output: Extract<AnswerModeOutput, { mode: "quick" }>;
  request?: string | null;
}) {
  return (
    <CustomerResult
      output={output}
      request={request}
      findings={output.findings}
      sources={output.sources}
    />
  );
}

function ExecutiveRenderer({
  output,
  request,
}: {
  output: Extract<AnswerModeOutput, { mode: "executive" }>;
  request?: string | null;
}) {
  const extras = (
    <>
      {output.risks?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Risks</p>
          <div className="mt-1">
            <EvidenceList items={output.risks} />
          </div>
        </div>
      ) : null}
    </>
  );
  return (
    <CustomerResult
      output={output}
      request={request}
      extras={extras}
      findings={output.findings}
      sources={output.sources}
    />
  );
}

function ActionRenderer({
  output,
  request,
  onCapability,
}: {
  output: Extract<AnswerModeOutput, { mode: "action" }>;
  request?: string | null;
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

  const extras = (
    <>
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
    </>
  );

  return (
    <CustomerResult
      output={output}
      request={request}
      extras={extras}
      findings={output.findings}
      sources={output.sources}
    />
  );
}

function DeepRenderer({
  output,
  request,
  onCapability,
}: {
  output: Extract<AnswerModeOutput, { mode: "deep" }>;
  request?: string | null;
  onCapability?: (label: string) => void;
}) {
  const extras = (
    <>
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
    </>
  );
  return (
    <CustomerResult
      output={output}
      request={request}
      extras={extras}
      findings={output.findings}
      sources={output.sources}
    />
  );
}

/**
 * Mode-specific Ask/Research output renderer with graceful legacy fallback.
 * Default view is always the four typed answers — never a sources-card wall.
 */
export function AnswerModeOutputView({ output, fallback, onCapability, request }: Props) {
  if (hasCompleteTypedAnswers(output) || isModeShapedOutput(output)) {
    if (isModeShapedOutput(output)) {
      switch (output.mode) {
        case "quick":
          return <QuickRenderer output={output} request={request} />;
        case "executive":
          return <ExecutiveRenderer output={output} request={request} />;
        case "action":
          return <ActionRenderer output={output} onCapability={onCapability} request={request} />;
        case "deep":
          return <DeepRenderer output={output} onCapability={onCapability} request={request} />;
        default:
          break;
      }
    }
    return <CustomerResult output={output} request={request} />;
  }

  return <>{fallback}</>;
}

/** Shared helper for tests / SSR checks — re-export. */
export { isModeShapedOutput };
