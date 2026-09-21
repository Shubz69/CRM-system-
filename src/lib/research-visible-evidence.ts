/**
 * Client-safe research evidence helpers (no Prisma).
 * Always expose source URL + snippet/title and finding→source linkage.
 * Never invents URLs or statistics.
 */

import { labelResearchListenChannel } from "@/lib/research-listen-platforms";

export type SourceBackedFinding = {
  claim: string;
  sourceUrl: string;
  evidenceExcerpt?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  claimKind: "OBSERVATION";
  confidence: number;
};

export type VisibleSource = {
  url: string;
  title?: string;
  snippet?: string;
  author?: string;
  platform?: string;
};

export type VisibleFinding = {
  claim: string;
  sourceUrl: string;
  evidenceExcerpt?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  claimKind?: string;
  confidence?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimText(value: unknown, max = 280): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function sourceSnippet(rec: Record<string, unknown>): string | undefined {
  return (
    trimText(rec.snippet) ||
    trimText(rec.content) ||
    trimText(rec.excerpt) ||
    trimText(rec.evidenceExcerpt)
  );
}

export function sourceBackedFindingsFromSources(
  sources: Array<{
    url: string;
    title?: string | null;
    content?: string | null;
    platform?: string | null;
  }>,
  limit = 8,
): SourceBackedFinding[] {
  const out: SourceBackedFinding[] = [];
  for (const source of sources) {
    if (!source.url || out.length >= limit) continue;
    const excerpt = (source.content || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const title = (source.title || "").trim();
    // Prefer a readable observation: title as the lead, excerpt as evidence —
    // never invent statistics beyond what the source text already states.
    const claim = title
      ? excerpt
        ? `${title} — ${excerpt}`
        : title
      : excerpt || `Source recorded: ${source.url}`;
    out.push({
      claim: claim.slice(0, 800),
      sourceUrl: source.url,
      evidenceExcerpt: excerpt || undefined,
      sourceTitle: title || undefined,
      sourcePlatform: labelResearchListenChannel(source.platform) || source.platform || undefined,
      claimKind: "OBSERVATION",
      confidence: excerpt ? 0.45 : 0.35,
    });
  }
  return out;
}

/**
 * Deterministic multi-source brief when LLM extract is skipped (FAST) or fails.
 * Uses only titles/domains/excerpts already retrieved — never invents facts.
 */
export function deterministicResearchBrief(
  topic: string,
  sources: Array<{
    url: string;
    title?: string | null;
    content?: string | null;
  }>,
): string {
  const cleanTopic = topic.replace(/\s+/g, " ").trim().slice(0, 160);
  const domains = [
    ...new Set(
      sources
        .map((s) => {
          try {
            return new URL(s.url).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ];
  const titled = sources
    .map((s) => {
      let domain = "";
      try {
        domain = new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }
      return {
        title: (s.title || "").replace(/\s+/g, " ").trim(),
        domain,
        excerpt: (s.content || "").replace(/\s+/g, " ").trim().slice(0, 140),
      };
    })
    .filter((s) => s.title || s.domain)
    .slice(0, 5);
  const titles = titled.map((s) => s.title).filter(Boolean);

  const wantsContentAngles =
    /\b(content ideas?|content plan|content strategy|what .{0,48}\b(post|publish)|post this (week|month)|marketing themes?)\b/i.test(
      cleanTopic,
    );

  if (wantsContentAngles && titled.length > 0) {
    const angles = titled.slice(0, 3).map((s, i) => {
      const lead = s.title || s.domain;
      const why = s.excerpt ? ` ${s.excerpt}` : "";
      return `${i + 1}. ${lead} — source-backed angle from ${s.domain || "retrieved page"}.${why}`;
    });
    return [
      `Source-backed content angles for “${cleanTopic}” (titles/excerpts from retrieved pages — verify before posting):`,
      ...angles,
      "These are evidence leads, not invented posts or unverified statistics.",
    ].join(" ");
  }

  const parts = [
    `Evidence scan for “${cleanTopic}”: ${sources.length} source${sources.length === 1 ? "" : "s"}`,
    domains.length
      ? `across ${domains.slice(0, 5).join(", ")}${domains.length > 5 ? ", …" : ""}`
      : null,
    titles.length
      ? `Key source leads: ${titles.map((t, i) => `(${i + 1}) ${t}`).join("; ")}.`
      : "Open the linked sources below to verify details before acting.",
    "This is a source-backed fast scan (observations from retrieved pages), not model-invented synthesis.",
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Decision-ready FAST synthesis from retrieved titles/excerpts/findings.
 * Never invents statistics. Interprets evidence for the named business.
 */
export function synthesiseResearchBrief(input: {
  topic: string;
  businessName?: string | null;
  audience?: string | null;
  sources: Array<{ url: string; title?: string | null; content?: string | null }>;
  findings?: Array<{ claim: string; sourceUrl: string }>;
}): string {
  const topic = input.topic.replace(/\s+/g, " ").trim().slice(0, 160);
  const business = (input.businessName || "this workspace").trim();
  const audience = (input.audience || "your audience").trim();
  const findings =
    input.findings && input.findings.length > 0
      ? input.findings.slice(0, 8)
      : sourceBackedFindingsFromSources(input.sources, 8).map((f) => ({
          claim: f.claim,
          sourceUrl: f.sourceUrl,
        }));
  const domains = [
    ...new Set(
      input.sources
        .map((s) => {
          try {
            return new URL(s.url).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ].slice(0, 6);
  const keys = findings.slice(0, 5).map((f, i) => {
    const claim = f.claim.replace(/\s+/g, " ").trim().slice(0, 220);
    return `${i + 1}. ${claim}`;
  });
  const wantsContent =
    /\b(content ideas?|content plan|what .{0,48}\b(post|publish)|post this (week|month)|marketing themes?)\b/i.test(
      topic,
    );
  const actions = wantsContent
    ? [
        `1. Turn finding 1 into a ${audience} hook — quote the source, do not invent stats.`,
        "2. Draft one LinkedIn post and one short-form script from findings 2–3, then send for approval.",
        "3. Reject any angle that does not match the workspace brand or audience above.",
      ]
    : [
        `1. Validate the strongest finding against ${business}'s current pipeline and audience before acting.`,
        "2. Pick one source-backed tactic this week; do not scale unproven blog advice.",
        "3. If a named company in sources is not this workspace, ignore it as a homograph.",
      ];
  const direct = wantsContent
    ? `Use ${Math.min(3, findings.length)} source-backed angles below for ${business}; they are retrieved leads, not finished posts.`
    : `From ${input.sources.length} retrieved source${input.sources.length === 1 ? "" : "s"}, the usable signal for ${business} is in the findings below — not in similarly named companies.`;
  return [
    `DIRECT ANSWER: ${direct}`,
    keys.length ? `KEY FINDINGS: ${keys.join(" ")}` : "KEY FINDINGS: None extracted — open the linked sources.",
    `WHAT THIS MEANS FOR ${business}: Treat these as market/context leads for ${audience}. Do not treat page titles as proof of your own traction or revenue.`,
    `RECOMMENDED ACTIONS: ${actions.join(" ")}`,
    `EVIDENCE: ${domains.join(", ") || "see linked sources"}.`,
    "UNCERTAINTIES: Fast scan; excerpts may be incomplete; verify claims on the source page before publishing or spending.",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeVisibleSources(output: unknown): VisibleSource[] {
  const obj = asRecord(output);
  const out: VisibleSource[] = [];
  const seen = new Set<string>();
  const push = (rec: Record<string, unknown> | null) => {
    const url = trimText(rec?.url, 2_000);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const author = trimText(rec?.author, 200);
    const rawPlatform = trimText(rec?.listenChannel, 80) || trimText(rec?.platform, 40);
    out.push({
      url,
      title: trimText(rec?.title, 300),
      snippet: rec ? sourceSnippet(rec) : undefined,
      author: author || undefined,
      platform: labelResearchListenChannel(rawPlatform) || rawPlatform,
    });
  };
  if (obj && Array.isArray(obj.sources)) {
    for (const item of obj.sources) push(asRecord(item));
  }
  const rows = obj
    ? [
        ...(Array.isArray(obj.findings) ? obj.findings : []),
        ...(Array.isArray(obj.claims) ? obj.claims : []),
      ]
    : [];
  for (const item of rows) {
    const rec = asRecord(item);
    const url = trimText(rec?.sourceUrl, 2_000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: trimText(rec?.sourceTitle, 300),
      snippet: rec ? sourceSnippet(rec) : undefined,
      platform: labelResearchListenChannel(trimText(rec?.sourcePlatform, 80) || trimText(rec?.platform, 40)),
    });
  }
  return out;
}

export function normalizeVisibleFindings(
  output: unknown,
  sources?: VisibleSource[],
): VisibleFinding[] {
  const obj = asRecord(output);
  const sourceList = sources ?? normalizeVisibleSources(output);
  const byUrl = new Map(sourceList.map((s) => [s.url, s]));
  const out: VisibleFinding[] = [];
  const seen = new Set<string>();
  const rows = obj
    ? [
        ...(Array.isArray(obj.findings) ? obj.findings : []),
        ...(Array.isArray(obj.claims) ? obj.claims : []),
      ]
    : [];
  for (const item of rows) {
    const rec = asRecord(item);
    const claim = trimText(rec?.claim, 800);
    const sourceUrl = trimText(rec?.sourceUrl, 2_000);
    if (!claim || !sourceUrl) continue;
    const key = `${claim.toLowerCase()}|${sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const matched = byUrl.get(sourceUrl);
    out.push({
      claim,
      sourceUrl,
      evidenceExcerpt: trimText(rec?.evidenceExcerpt, 400) || matched?.snippet,
      sourceTitle: trimText(rec?.sourceTitle, 300) || matched?.title,
      sourcePlatform:
        labelResearchListenChannel(trimText(rec?.sourcePlatform, 80) || matched?.platform) ||
        matched?.platform,
      claimKind: trimText(rec?.claimKind, 40),
      confidence:
        typeof rec?.confidence === "number" && Number.isFinite(rec.confidence)
          ? rec.confidence
          : undefined,
    });
  }
  if (out.length === 0 && sourceList.length > 0) {
    return sourceBackedFindingsFromSources(
      sourceList.map((s) => ({
        url: s.url,
        title: s.title,
        content: s.snippet,
        platform: s.platform,
      })),
    );
  }
  return out;
}

export function attachVisibleResearchEvidence(output: unknown): unknown {
  const obj = asRecord(output);
  if (!obj) return output;
  if (obj.source === "internal_crm") return output;
  const looksResearch =
    typeof obj.researchJobId === "string" ||
    Array.isArray(obj.sources) ||
    Array.isArray(obj.findings) ||
    Array.isArray(obj.claims) ||
    obj.phase === "PARTIAL_WITH_SOURCES";
  if (!looksResearch) return output;
  const sources = normalizeVisibleSources(obj);
  const findings = normalizeVisibleFindings(obj, sources);
  if (sources.length === 0 && findings.length === 0) return output;
  return { ...obj, sources, findings };
}
