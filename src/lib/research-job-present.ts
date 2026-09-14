/**
 * Customer-facing ResearchJob presentation.
 * findings=0 with sources>0 must still show quoted source excerpts
 * (partial_sources_only honesty) — never invent statistics.
 */
import { sourceBackedFindingsFromSources } from "@/lib/research-visible-evidence";

export function isPartialSourcesOnlyError(error: string | null | undefined): boolean {
  return typeof error === "string" && /partial_sources_only/i.test(error.trim());
}

/** True when web search failed because TAVILY/EXA keys are missing or rejected on this process. */
export function isWebResearchAuthRequiredOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const obj = output as Record<string, unknown>;
  if (obj.error === "AUTH_REQUIRED") return true;
  if (typeof obj.summary === "string" && /\bAUTH_REQUIRED\b/.test(obj.summary)) return true;
  if (typeof obj.userFacingError === "string" && /\bAUTH_REQUIRED\b/.test(obj.userFacingError)) {
    return true;
  }
  if (!Array.isArray(obj.adapterErrors)) return false;
  return obj.adapterErrors.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const rec = entry as { code?: string; message?: string };
    return rec.code === "AUTH_REQUIRED" || (typeof rec.message === "string" && /\bAUTH_REQUIRED\b/.test(rec.message));
  });
}

/** Drop the scary total-failure banner when sources were actually gathered. */
export function softenPartialSourcesOnlyError(input: {
  error: string | null;
  userFacingError: string | null;
  sourceCount: number;
}): { error: string | null; userFacingError: string | null } {
  if (input.sourceCount <= 0 || !isPartialSourcesOnlyError(input.error)) {
    return { error: input.error, userFacingError: input.userFacingError };
  }
  return { error: null, userFacingError: null };
}

export type QuotedResearchFinding = {
  id: string;
  claim: string;
  evidenceExcerpt: string | null;
  confidence: number;
  claimKind: string;
  freshnessScore: number | null;
  verifiedByCritic: boolean;
  flaggedUnsupported: boolean;
  flaggedUngrounded: boolean;
  sourceUrl: string;
  sourcePlatform: string | null;
  listenChannel: string | null;
  source: Record<string, unknown> | null;
};

/** Quote stored source snippets as findings. Does not invent URLs or stats. */
export function quotedFindingsFromResearchSources(
  sources: Array<{
    id?: string;
    url: string;
    title?: string | null;
    snippet?: string | null;
    content?: string | null;
    platform?: string | null;
    listenChannel?: string | null;
  }>,
): QuotedResearchFinding[] {
  const backed = sourceBackedFindingsFromSources(
    sources.map((s) => ({
      url: s.url,
      title: s.title,
      content: s.snippet || s.content,
      platform: s.platform,
    })),
  );
  return backed.map((finding, index) => {
    const src = sources.find((s) => s.url === finding.sourceUrl);
    return {
      id: src?.id ? `quoted-${src.id}` : `quoted-${index}`,
      claim: finding.claim,
      evidenceExcerpt: finding.evidenceExcerpt ?? null,
      confidence: finding.confidence,
      claimKind: finding.claimKind,
      freshnessScore: null,
      verifiedByCritic: false,
      flaggedUnsupported: false,
      flaggedUngrounded: false,
      sourceUrl: finding.sourceUrl,
      sourcePlatform: finding.sourcePlatform ?? src?.platform ?? null,
      listenChannel: src?.listenChannel ?? null,
      source: src
        ? {
            id: src.id,
            url: src.url,
            title: src.title ?? null,
            platform: src.platform ?? null,
            listenChannel: src.listenChannel ?? null,
            snippet: src.snippet ?? finding.evidenceExcerpt ?? null,
          }
        : null,
    };
  });
}
