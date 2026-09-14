/**
 * Source-backed PARTIAL salvage when Ask research hits the wall clock
 * before the supervisor can shape a normal finalOutput.
 * Never invents URLs or statistics — only persisted sources/findings/brief.
 */
import { prisma } from "@/lib/db";
import { asSafePrismaId } from "@/lib/safe-prisma-id";
import {
  sourceBackedFindingsFromSources,
  type VisibleFinding,
  type VisibleSource,
} from "@/lib/research-visible-evidence";
import { looksLikeResearchOutput } from "@/agents/supervisor/research-deadline";

export type SalvagedResearchPartial = {
  researchJobId: string;
  topic: string;
  summary: string;
  findings: VisibleFinding[];
  sources: VisibleSource[];
  sourceCount: number;
  phase: "PARTIAL_WITH_SOURCES";
  caveats: string[];
};

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
            `Research gathered ${sources.length || findings.length} source${
              (sources.length || findings.length) === 1 ? "" : "s"
            } before the time limit. Findings quote collected pages — they are not invented statistics.`,
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
            "This run hit the time limit. Listed sources and quoted excerpts were gathered before stop — not fully synthesised claims.",
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
    summary: `Research gathered ${sources.length || findings.length} source${
      (sources.length || findings.length) === 1 ? "" : "s"
    } before the time limit. Findings quote collected pages — they are not invented statistics.`,
    findings,
    sources,
    sourceCount: sources.length || findings.length,
    phase: "PARTIAL_WITH_SOURCES",
    caveats: [
      "This run hit the time limit. Listed sources and quoted excerpts were gathered before stop — not fully synthesised claims.",
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
