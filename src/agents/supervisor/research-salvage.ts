/**
 * Source-backed PARTIAL salvage when Ask research hits the wall clock
 * before the supervisor can shape a normal finalOutput.
 * Never invents URLs or statistics — only persisted sources/findings/brief.
 */
import { prisma } from "@/lib/db";
import { asSafePrismaId } from "@/lib/safe-prisma-id";
import {
  attachVisibleResearchEvidence,
  sourceBackedFindingsFromSources,
  type VisibleFinding,
  type VisibleSource,
} from "@/lib/research-visible-evidence";
import { looksLikeResearchOutput } from "@/agents/supervisor/research-deadline";

export type SalvagedResearchPartial = {
  researchJobId?: string;
  topic: string;
  summary: string;
  answer?: string;
  findings: VisibleFinding[];
  sources: VisibleSource[];
  sourceCount: number;
  phase: "PARTIAL_WITH_SOURCES";
  caveats: string[];
};

/** Honest non-null PARTIAL when the wall clock fires before any source is persisted. */
export function honestEmptyResearchPartial(request?: string): SalvagedResearchPartial {
  const topic = (request || "").replace(/\s+/g, " ").trim().slice(0, 500) || "Research";
  const summary =
    "I ran out of time before sourced findings were ready. Nothing below was invented — try again.";
  return {
    topic,
    summary,
    answer: summary,
    findings: [],
    sources: [],
    sourceCount: 0,
    phase: "PARTIAL_WITH_SOURCES",
    caveats: ["This run hit the time limit before sources were persisted."],
  };
}

/** True when Ask would render a blank brief (null output or empty steps with no text/sources). */
export function isBlankAskFinalOutput(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return !value.trim();
  if (typeof value !== "object" || Array.isArray(value)) return true;
  const obj = value as Record<string, unknown>;
  const text = [
    obj.answer,
    obj.summary,
    obj.shortAnswer,
    obj.brief,
    obj.keyFinding,
    obj.executiveSummary,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("");
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  const sources = Array.isArray(obj.sources) ? obj.sources : [];
  const claims = Array.isArray(obj.claims) ? obj.claims : [];
  const typed = obj.typedAnswers;
  const typedFilled =
    typed &&
    typeof typed === "object" &&
    ["strategy", "scripts", "postingPlan", "monetization"].every((key) => {
      const rec = (typed as Record<string, unknown>)[key];
      return (
        rec &&
        typeof rec === "object" &&
        typeof (rec as { body?: unknown }).body === "string" &&
        (rec as { body: string }).body.trim().length > 0
      );
    });
  return !text && findings.length === 0 && sources.length === 0 && claims.length === 0 && !typedFilled;
}

function sourceCountOf(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const obj = value as Record<string, unknown>;
  const sources = Array.isArray(obj.sources) ? obj.sources.length : 0;
  const findings = Array.isArray(obj.findings) ? obj.findings.length : 0;
  return sources || findings;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimText(value: unknown, max = 800): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

/** Map a persisted ResearchJob (+ sources/findings or brief) into Ask-visible evidence. */
export function researchPartialFromJobRow(job: {
  id: string;
  topic?: string | null;
  brief?: unknown;
  sources?: Array<{
    url: string;
    title?: string | null;
    content?: string | null;
    platform?: string | null;
    author?: string | null;
  }>;
  findings?: Array<{
    claim: string;
    evidenceExcerpt?: string | null;
    source?: { url?: string | null; title?: string | null; platform?: string | null };
  }>;
}): SalvagedResearchPartial | null {
  const brief = asRecord(job.brief);
  if (brief && looksLikeResearchOutput(brief)) {
    const briefSources = Array.isArray(brief.sources)
      ? (brief.sources as VisibleSource[]).filter((s) => s && typeof s.url === "string" && s.url)
      : [];
    const briefFindings = Array.isArray(brief.findings)
      ? (brief.findings as VisibleFinding[]).filter(
          (f) => f && typeof f.claim === "string" && typeof f.sourceUrl === "string" && f.sourceUrl,
        )
      : [];
    if (briefSources.length > 0 || briefFindings.length > 0) {
      const sources = briefSources;
      const findings =
        briefFindings.length > 0
          ? briefFindings
          : sourceBackedFindingsFromSources(
              sources.map((s) => ({
                url: s.url,
                title: s.title,
                content: s.snippet,
                platform: s.platform,
              })),
            );
      if (sources.length === 0 && findings.length === 0) {
        /* fall through to row-level sources */
      } else {
        return {
          researchJobId: job.id,
          topic: trimText(job.topic, 500) || trimText(brief.topic, 500) || "Research",
          summary:
            trimText(brief.summary, 1_200) ||
            `Finished a time-boxed scan of ${trimText(job.topic, 80) || "this topic"} using ${sources.length || findings.length} gathered page${
              (sources.length || findings.length) === 1 ? "" : "s"
            }. The four answers below use that evidence — they are not invented statistics.`,
          findings,
          sources: sources.length
            ? sources
            : findings.map((f) => ({
                url: f.sourceUrl,
                title: f.sourceTitle,
                snippet: f.evidenceExcerpt,
                platform: f.sourcePlatform,
              })),
          sourceCount: sources.length || findings.length,
          phase: "PARTIAL_WITH_SOURCES",
          caveats: [
            "This run used everything gathered inside the time budget. The four answers are synthesised from quoted evidence — not a sources-only dump.",
          ],
        };
      }
    }
  }

  const sourceRows = job.sources ?? [];
  const sources: VisibleSource[] = [];
  const seen = new Set<string>();
  for (const row of sourceRows) {
    const url = trimText(row.url, 2_000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: trimText(row.title, 300),
      snippet: trimText(row.content, 280),
      author: trimText(row.author, 200),
      platform: trimText(row.platform, 80),
    });
  }

  const findingsFromRows: VisibleFinding[] = [];
  for (const row of job.findings ?? []) {
    const claim = trimText(row.claim, 800);
    const sourceUrl = trimText(row.source?.url, 2_000);
    if (!claim || !sourceUrl) continue;
    findingsFromRows.push({
      claim,
      sourceUrl,
      evidenceExcerpt: trimText(row.evidenceExcerpt, 400),
      sourceTitle: trimText(row.source?.title, 300),
      sourcePlatform: trimText(row.source?.platform, 80),
    });
  }

  const findings =
    findingsFromRows.length > 0
      ? findingsFromRows
      : sourceBackedFindingsFromSources(
          sources.map((s) => ({
            url: s.url,
            title: s.title,
            content: s.snippet,
            platform: s.platform,
          })),
        );

  if (sources.length === 0 && findings.length === 0) return null;

  return {
    researchJobId: job.id,
    topic: trimText(job.topic, 500) || "Research",
    summary: `Finished a time-boxed scan of ${trimText(job.topic, 80) || "this topic"} using ${sources.length || findings.length} gathered page${
      (sources.length || findings.length) === 1 ? "" : "s"
    }. The four answers below use that evidence — they are not invented statistics.`,
    findings,
    sources,
    sourceCount: sources.length || findings.length,
    phase: "PARTIAL_WITH_SOURCES",
    caveats: [
      "This run used everything gathered inside the time budget. The four answers are synthesised from quoted evidence — not a sources-only dump.",
    ],
  };
}

export async function salvageResearchPartialFromDb(input: {
  organisationId: string;
  agentRunId: string;
}): Promise<SalvagedResearchPartial | null> {
  const organisationId = asSafePrismaId(input.organisationId);
  const agentRunId = asSafePrismaId(input.agentRunId);
  const job = await prisma.researchJob.findFirst({
    where: {
      organisationId: { equals: organisationId },
      agentRunId: { equals: agentRunId },
    },
    orderBy: { createdAt: "desc" },
    include: {
      sources: {
        where: { organisationId: { equals: organisationId } },
        orderBy: { createdAt: "asc" },
        take: 12,
      },
      findings: {
        where: { organisationId: { equals: organisationId } },
        orderBy: { createdAt: "asc" },
        take: 12,
        include: {
          source: { select: { url: true, title: true, platform: true } },
        },
      },
    },
  });
  if (!job) return null;
  return researchPartialFromJobRow(job);
}

/**
 * Read-path safety net for every organisation: blank Ask research PARTIAL
 * (legacy MAX_WALL_CLOCK with null finalOutput) still surfaces org-scoped
 * sources when a ResearchJob exists, otherwise an honest empty brief.
 */
export async function hydrateBlankResearchFinalOutput(input: {
  organisationId: string;
  agentRunId: string;
  request: string;
  status: string;
  finalOutput: unknown;
  lastCompletedOutput?: unknown;
}): Promise<{ finalOutput: unknown; salvaged: boolean; sourceCount: number }> {
  const terminal =
    input.status === "PARTIAL" || input.status === "COMPLETED" || input.status === "FAILED";
  if (!terminal) {
    return {
      finalOutput: input.finalOutput,
      salvaged: false,
      sourceCount: sourceCountOf(input.finalOutput),
    };
  }

  for (const candidate of [input.finalOutput, input.lastCompletedOutput]) {
    if (!isBlankAskFinalOutput(candidate)) {
      const attached = attachVisibleResearchEvidence(candidate);
      return {
        finalOutput: attached,
        salvaged: false,
        sourceCount: sourceCountOf(attached),
      };
    }
  }

  const salvaged = await salvageResearchPartialFromDb({
    organisationId: input.organisationId,
    agentRunId: input.agentRunId,
  });
  const raw = salvaged ?? honestEmptyResearchPartial(input.request);
  const attached = attachVisibleResearchEvidence(raw);
  return {
    finalOutput: attached,
    salvaged: Boolean(salvaged),
    sourceCount: salvaged?.sourceCount ?? sourceCountOf(attached),
  };
}
