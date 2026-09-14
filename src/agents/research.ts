import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { assertEntitlement, recordMeteredUsage } from "@/services/entitlements";
import { prisma } from "@/lib/db";
import { asSafePrismaId, updateOrgScopedById } from "@/lib/safe-prisma-id";
import { recordResearchToolCall } from "@/services/research-tool-calls";
import {
  parseClaimKind,
  persistResearchSourceWithSnapshot,
  sourceBackedFindingsFromSources,
} from "@/services/research-evidence";
import { ingestResearchJobSocialContent } from "@/services/social-intelligence";
import {
  dedupeSourceResults,
  formatUnavailableSourceNotes,
  listConfiguredSourcePlatforms,
  rankSourceResults,
  searchConfiguredSources,
  type SourcePlatform,
  type SourceResult,
} from "@/adapters/sources";
import { hasWebSearchCredentials, WEB_SEARCH_MISSING_KEY_MESSAGE } from "@/adapters/sources/web";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { authorityFirstQueries, isPrimaryAuthorityUrl, ukPrimaryAuthorityDomains, classifyResearchStakes } from "@/lib/research-authority";
import { inferResearchListenPlatforms, labelResearchListenChannel } from "@/lib/research-listen-platforms";
import {
  RESEARCH_EXTRACT_MIN_MS,
  RESEARCH_HARD_CEILING_MS,
  RESEARCH_QUERY_CAP,
  RESEARCH_QUICK_CEILING_MS,
  RESEARCH_SOURCE_CAP,
  RESEARCH_SOURCE_FETCH_MS,
  raceWithTimeout,
} from "@/agents/supervisor/research-deadline";

export const researchInputSchema = z.object({
  topic: z.string().min(3).max(2000),
  /** Optional niche / industry hint — never assumed to be Instagram marketing. */
  nicheHint: z.string().max(200).optional(),
  maxSources: z.number().int().min(5).max(40).optional(),
  /** FAST = Quick Answer budgeted scan (fewer queries / sources). */
  depth: z.enum(["FAST", "STANDARD", "DEEP"]).optional(),
  platforms: z
    .array(z.enum(["youtube", "reddit", "web", "instagram", "linkedin", "tiktok"]))
    .optional(),
});

/** Accept absolute URLs; models often omit scheme — coerce http(s) when possible. */
const flexibleSourceUrl = z
  .string()
  .min(1)
  .transform((raw) => {
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  })
  .pipe(z.string().url());

const findingSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: flexibleSourceUrl,
  evidenceExcerpt: z.string().optional(),
  sourceTitle: z.string().optional(),
  claimKind: z
    .enum(["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const researchOutputSchema = z.object({
  researchJobId: z.string(),
  topic: z.string(),
  queries: z.array(z.string()),
  sourceCount: z.number().int().nonnegative(),
  findings: z.array(findingSchema),
  sources: z.array(
    z.object({
      url: z.string().url(),
      title: z.string(),
      platform: z.string(),
      listenChannel: z.string().optional(),
      snippet: z.string().optional(),
      author: z.string().nullable().optional(),
    }),
  ),
  summary: z.string(),
  adapterErrors: z.array(z.object({ platform: z.string(), message: z.string() })),
  /** Honest degrade markers when sources exist but findings are incomplete. */
  phase: z.string().optional(),
  caveats: z.array(z.string()).optional(),
  /** Persistable failure code — AUTH_REQUIRED vs no_sources. Never invent keys. */
  error: z.string().optional(),
});

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

const FINDING_CLAIM_MAX = 800;

const findingItemSchema = z.object({
  claim: z.string().min(1).max(FINDING_CLAIM_MAX),
  sourceUrl: flexibleSourceUrl,
  evidenceExcerpt: z.string().max(800).optional(),
  claimKind: z
    .enum(["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});

function coerceFindingConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1 && value <= 100) return Math.max(0, Math.min(1, value / 100));
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (!Number.isFinite(n)) return undefined;
    if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100));
    return Math.max(0, Math.min(1, n));
  }
  return undefined;
}

/**
 * Keep schema-valid findings when the model mix includes invalid items.
 * Does not invent claims — only retains items that already have claim + URL.
 */
export function salvageExtractedFindings(
  raw: unknown,
): z.infer<typeof findingItemSchema>[] {
  let arr: unknown[] | null = null;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.findings)) arr = obj.findings;
    else if (Array.isArray(obj.claims)) arr = obj.claims;
  }
  if (!arr) return [];
  const out: z.infer<typeof findingItemSchema>[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const claim = typeof rec.claim === "string" ? rec.claim.trim().slice(0, FINDING_CLAIM_MAX) : "";
    if (!claim) continue;
    const excerpt =
      typeof rec.evidenceExcerpt === "string" ? rec.evidenceExcerpt.trim().slice(0, 800) : undefined;
    const parsed = findingItemSchema.safeParse({
      claim,
      sourceUrl: rec.sourceUrl,
      evidenceExcerpt: excerpt || undefined,
      claimKind: rec.claimKind,
      confidence: coerceFindingConfidence(rec.confidence),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, 40);
}

type FindingsExtract = { findings: z.infer<typeof findingItemSchema>[] };

/** Extraction contract used by research findings / claim structuring. */
export const findingsExtractSchema: z.ZodType<FindingsExtract> = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const arr = Array.isArray(obj.findings)
    ? obj.findings
    : Array.isArray(obj.claims)
      ? obj.claims
      : null;
  if (!arr) return raw;
  return { findings: salvageExtractedFindings({ findings: arr }) };
}, z.object({ findings: z.array(findingItemSchema).max(40) })) as z.ZodType<FindingsExtract>;

/** Hand-written JSON Schema for Anthropic native structured output (matches findingsExtractSchema). */
export const FINDINGS_EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          sourceUrl: { type: "string" },
          evidenceExcerpt: { type: "string" },
          claimKind: {
            type: "string",
            enum: ["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"],
          },
          confidence: { type: "number" },
        },
        required: ["claim", "sourceUrl"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

function engagementScore(r: SourceResult): number {
  return r.engagement?.score ?? r.engagement?.views ?? r.engagement?.likes ?? 0;
}

/**
 * Research agent — heuristic queries, parallel source search with hard timeouts,
 * optional extract LLM (skipped on FAST / tight deadline), then source-backed findings.
 */
export const researchAgent: Agent<ResearchInput, ResearchOutput> = {
  name: "research",
  description:
    "Researches a topic across configured web and social sources, returning findings with source URLs only.",
  inputSchema: researchInputSchema,
  outputSchema: researchOutputSchema,
  tier: "cheap",
  estimateCostCents: (input) => {
    const maxSources = input.maxSources ?? 28;
    return Math.max(3, Math.ceil(maxSources / 5) + 2);
  },
  userFacingLabel: (input) => {
    const topic = (input.topic || "your topic").trim().slice(0, 80);
    return `Researching “${topic}” across available sources`;
  },
  async execute(input, ctx) {
    const parsed = researchInputSchema.parse(input);
    const { sanitizeResearchTopic, stripClarificationMetadata } = await import(
      "@/lib/agent-request-sanitize"
    );
    const topic =
      sanitizeResearchTopic(parsed.topic) ||
      stripClarificationMetadata(parsed.topic).slice(0, 2000);
    if (topic.length < 3) {
      throw new Error("I need a clearer research topic before I can search sources.");
    }
    const depth = parsed.depth ?? "STANDARD";
    const fast = depth === "FAST";
    const maxSources =
      parsed.maxSources ??
      (depth === "FAST"
        ? RESEARCH_SOURCE_CAP.FAST
        : depth === "DEEP"
          ? RESEARCH_SOURCE_CAP.DEEP
          : RESEARCH_SOURCE_CAP.STANDARD);
    const organisationId = asSafePrismaId(ctx.organisationId);
    await assertEntitlement(organisationId, "research");
    await assertWithinSpendCap(organisationId, researchAgent.estimateCostCents(parsed));

    const model = resolveModelForTier("cheap");
    let costCents = 0;
    const executeStarted = Date.now();
    const ownCeiling = fast ? RESEARCH_QUICK_CEILING_MS : RESEARCH_HARD_CEILING_MS;
    const deadlineAt = Math.min(executeStarted + ownCeiling, ctx.deadlineAt ?? executeStarted + ownCeiling);
    const remainingMs = () => deadlineAt - Date.now();
    const latency = {
      expandMs: 0,
      searchMs: 0,
      extractMs: 0,
      persistMs: 0,
    };

    // Skip query-expand LLM — heuristic queries stay inside the 30s / 8s ceiling.
    const tExpand0 = Date.now();
    const queryCap =
      depth === "FAST"
        ? RESEARCH_QUERY_CAP.FAST
        : depth === "DEEP"
          ? RESEARCH_QUERY_CAP.DEEP
          : RESEARCH_QUERY_CAP.STANDARD;
    const year = new Date().getFullYear();
    const queries = [
      ...authorityFirstQueries(topic),
      ...new Set([topic, `${topic} ${year}`]),
    ].slice(0, queryCap);
    latency.expandMs = Date.now() - tExpand0;

    const job = await prisma.researchJob.create({
      data: {
        organisationId: organisationId,
        agentRunId: ctx.agentRunId,
        kind: "RESEARCH",
        topic,
        status: "RUNNING",
        queries,
        startedAt: new Date(),
      },
    });
    const jobId = asSafePrismaId(job.id);

    const configuredPlatforms = listConfiguredSourcePlatforms();
    const explicitPlatforms = (parsed.platforms as SourcePlatform[] | undefined)?.length
      ? (parsed.platforms as SourcePlatform[])
      : null;
    const authorityDomains = ukPrimaryAuthorityDomains(topic);
    const isHighStakes = classifyResearchStakes(topic) === "HIGH_STAKES_REGULATORY";
    // Desk research stays web-only unless the topic names a social network
    // (or the caller passes platforms). Apify IG/LI/TT adapters stay wired
    // and time-bounded — do not fan out every scraper on GDPR/plant-hire asks.
    const platforms =
      explicitPlatforms ?? inferResearchListenPlatforms(topic, configuredPlatforms);

    const concurrency = Number(getEnv().RESEARCH_ADAPTER_CONCURRENCY || 3);
    const collected: SourceResult[] = [];
    const adapterErrors: Array<{ platform: string; message: string; code?: string }> = [];
    /** Reserve evidence budget for primary authorities before secondary fill. */
    const primaryReserve = isHighStakes ? Math.min(12, Math.max(6, Math.floor(maxSources / 2))) : 0;
    /** Platforms that failed hard this run — do not re-hit on later queries. */
    const coldPlatforms = new Set<SourcePlatform>();
    let activePlatforms = [...platforms];
    const COLD_CODES = new Set([
      "SOURCE_UNAVAILABLE",
      "SOURCE_RATE_LIMITED",
      "SOURCE_NOT_CONFIGURED",
      "AUTH_REQUIRED",
      "APIFY_DENIED",
      "APIFY_RUN_FAILED",
    ]);

    async function runSearch(
      query: string,
      searchOptions: {
        limit: number;
        includeDomains?: string[];
      },
    ): Promise<{ resultCount: number; allPlatformsFailed: boolean }> {
      const started = Date.now();
      const requested = searchOptions.includeDomains?.length
        ? (["web"] as SourcePlatform[])
        : activePlatforms;
      const usePlatforms = requested.filter((p) => !coldPlatforms.has(p));
      if (usePlatforms.length === 0) {
        return { resultCount: 0, allPlatformsFailed: true };
      }
      try {
        const { results, errors, billableCents } = await searchConfiguredSources({
          query,
          platforms: usePlatforms,
          concurrency,
          options: {
            organisationId: organisationId,
            limit: searchOptions.limit,
            recent: true,
            nicheHint: parsed.nicheHint,
            includeDomains: searchOptions.includeDomains,
            qualityBudget: fast ? "FAST" : depth === "DEEP" ? "DEEP" : "STANDARD",
            timeoutMs: Math.min(
              depth === "FAST"
                ? RESEARCH_SOURCE_FETCH_MS.FAST
                : depth === "DEEP"
                  ? RESEARCH_SOURCE_FETCH_MS.DEEP
                  : RESEARCH_SOURCE_FETCH_MS.STANDARD,
              Math.max(1_200, remainingMs() - 500),
            ),
          },
        });
        collected.push(...results);
        costCents += billableCents;
        for (const err of errors) {
          adapterErrors.push({ platform: err.platform, message: err.message, code: err.code });
          // Timeouts must not permanently cold-cache web on FAST — one hung
          // include_domains pass used to skip the unconstrained plant-hire search.
          const coldOnTimeout = err.code === "SOURCE_UNAVAILABLE" && err.platform === "web" && fast;
          if (COLD_CODES.has(err.code) && !coldOnTimeout) {
            coldPlatforms.add(err.platform);
          }
        }
        activePlatforms = activePlatforms.filter((p) => !coldPlatforms.has(p));
        await recordResearchToolCall({
          organisationId: organisationId,
          agentStepId: ctx.agentStepId,
          toolName: "source.search",
          args: {
            query,
            platforms: usePlatforms,
            organisationId: organisationId,
            includeDomains: searchOptions.includeDomains ?? null,
          },
          result: {
            count: results.length,
            urls: results.map((r) => r.url).slice(0, 40),
            primaryCount: results.filter((r) => isPrimaryAuthorityUrl(r.url)).length,
            errors: errors.map((e) => ({ platform: e.platform, code: e.code })),
            coldPlatforms: [...coldPlatforms],
          },
          durationMs: Date.now() - started,
        });
        const errored = new Set(errors.map((e) => e.platform));
        const allPlatformsFailed =
          results.length === 0 && usePlatforms.every((p) => errored.has(p));
        return { resultCount: results.length, allPlatformsFailed };
      } catch (error) {
        const message = error instanceof Error ? error.message : "search failed";
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "SOURCE_UNAVAILABLE";
        adapterErrors.push({ platform: "web", message, code });
        if (code !== "SOURCE_UNAVAILABLE" || !fast) {
          coldPlatforms.add("web");
        }
        activePlatforms = activePlatforms.filter((p) => !coldPlatforms.has(p));
        await recordResearchToolCall({
          organisationId: organisationId,
          agentStepId: ctx.agentStepId,
          toolName: "source.search",
          args: {
            query,
            platforms: usePlatforms,
            organisationId: organisationId,
            includeDomains: searchOptions.includeDomains ?? null,
          },
          error: message,
          durationMs: Date.now() - started,
        });
        return { resultCount: 0, allPlatformsFailed: true };
      }
    }

    const tSearch0 = Date.now();
    const searchTasks: Array<{
      query: string;
      limit: number;
      includeDomains?: string[];
    }> = [];
    // Authority include_domains is slow/empty on FAST — spend the budget on
    // one unconstrained web query so plant-hire style asks can return a URL.
    if (!fast && authorityDomains.length && remainingMs() > 1_200) {
      const authorityQuery = authorityFirstQueries(topic)[0] || topic;
      for (const domain of authorityDomains.slice(0, fast ? 1 : 2)) {
        searchTasks.push({
          query: authorityQuery,
          limit: Math.max(3, Math.ceil(primaryReserve / Math.max(authorityDomains.length, 1))),
          includeDomains: [domain],
        });
      }
    }
    const perQueryLimit = Math.ceil(maxSources / Math.max(queries.length, 1)) + 2;
    for (const query of queries) {
      searchTasks.push({ query, limit: perQueryLimit });
    }

    await raceWithTimeout(
      Promise.all(
        searchTasks.map(async (task) => {
          if (remainingMs() < 800) return;
          await runSearch(task.query, {
            limit: task.limit,
            includeDomains: task.includeDomains,
          });
        }),
      ),
      Math.max(200, remainingMs() - 400),
      () => undefined,
    );
    latency.searchMs = Date.now() - tSearch0;

    const deduped = dedupeSourceResults(collected);
    const primary = deduped.filter((r) => isPrimaryAuthorityUrl(r.url));
    const secondary = rankSourceResults(deduped.filter((r) => !isPrimaryAuthorityUrl(r.url)));
    // High-stakes: fill primary reserve first so blogs cannot crowd out authorities.
    const ranked = isHighStakes
      ? [
          ...primary.slice(0, primaryReserve),
          ...secondary.slice(0, Math.max(0, maxSources - Math.min(primary.length, primaryReserve))),
          ...primary.slice(primaryReserve),
        ].slice(0, maxSources)
      : [...primary, ...secondary].slice(0, maxSources);

    const tPersistSources0 = Date.now();
    const sourceRows = await Promise.all(
      ranked.map(async (r) => {
        const persisted = await persistResearchSourceWithSnapshot({
          organisationId: organisationId,
          researchJobId: jobId,
          url: r.url,
          title: r.title,
          platform: r.platform,
          author: r.author,
          publishedAt: r.publishedAt,
          content: r.content,
          engagement: (r.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          rawMetadata: r.rawMetadata as Prisma.InputJsonValue,
          queryUsed: parsed.topic,
        });
        return {
          id: persisted.sourceId,
          url: r.url,
          freshnessScore: persisted.freshnessScore,
        };
      }),
    );
    const persistSourcesMs = Date.now() - tPersistSources0;

    const urlToId = new Map(sourceRows.map((s) => [s.url, s.id]));
    const urlToFreshness = new Map(sourceRows.map((s) => [s.url, s.freshnessScore]));
    const catalog = ranked
      .map(
        (r) =>
          `URL: ${r.url}\nTitle: ${r.title}\nPlatform: ${r.platform}\nEngagement: ${engagementScore(r)}\nExcerpt:\n${r.content.slice(0, 1200)}`,
      )
      .join("\n\n----\n\n");

    type ExtractedFinding = z.infer<typeof findingItemSchema>;
    let extractedFindings: ExtractedFinding[] = [];
    let extractionDegraded = false;
    const tExtract0 = Date.now();
    const remainingBeforeExtract = remainingMs();
    const skipLlmExtract =
      fast || remainingBeforeExtract < RESEARCH_EXTRACT_MIN_MS || !catalog;
    if (!skipLlmExtract) {
      await assertWithinSpendCap(organisationId, 2);
      const findingLimit = Math.min(maxSources, 15);
      const extractBudget = Math.max(
        1_000,
        Math.min(remainingMs() - 1_500, 12_000),
      );
      const extractResult = await raceWithTimeout(
        completeStructuredSafe(findingsExtractSchema, {
          organisationId: organisationId,
          tier: "cheap",
          model,
          maxTokens: 8192,
          skipRepair: remainingMs() < RESEARCH_EXTRACT_MIN_MS + 4_000,
          jsonSchema: FINDINGS_EXTRACT_JSON_SCHEMA as unknown as Record<string, unknown>,
          repairHint:
            'Required shape: {"findings":[{"claim":"...","sourceUrl":"https://...","evidenceExcerpt":"...","claimKind":"OFFICIAL"}]}. sourceUrl must exactly match a provided URL.',
          system:
            'Extract factual findings from the sources. Return ONLY JSON shaped as {"findings":[...]}. Every finding MUST include claim and sourceUrl exactly matching one provided URL. Prefer claimKind OFFICIAL (primary docs), OBSERVATION, INFERENCE, or SECONDARY. Include a short evidenceExcerpt copied from the source when possible. Never invent statistics or URLs. If unsure, omit that finding.',
          prompt: `Topic: ${topic}\n\nSources:\n${catalog.slice(0, 45_000)}\n\nReturn up to ${findingLimit} findings.`,
          temperature: 0.1,
        }),
        extractBudget,
        () => ({
          ok: false as const,
          reason: "extract_timeout",
          raw: undefined,
          failureClass: "PROVIDER_FAILED" as const,
        }),
      );
      costCents += 2;
      if (extractResult.ok) {
        extractedFindings = extractResult.data.findings;
      } else {
        const {
          isAiProviderAuthError,
          RESEARCH_SYNTHESIS_FAILED_CUSTOMER,
        } = await import("@/services/ai-provider-preflight");
        if (isAiProviderAuthError(extractResult.reason)) {
          logger.warn("Research findings extract failed — provider authentication", {
            researchJobId: jobId,
            organisationId: organisationId,
            phase: "SYNTHESIS_FAILED",
            evidenceGathered: ranked.length > 0,
          });
          await updateOrgScopedById(prisma.researchJob, {
            id: jobId,
            organisationId,
            data: {
              status: "FAILED",
              brief: {
                phase: "SYNTHESIS_FAILED",
                evidenceGathered: true,
                sourceCount: ranked.length,
              } as unknown as Prisma.InputJsonValue,
              totalCostCents: costCents,
              finishedAt: new Date(),
              userFacingError: RESEARCH_SYNTHESIS_FAILED_CUSTOMER,
              error: "synthesis_auth_failed",
            },
          });
          const err = new Error(RESEARCH_SYNTHESIS_FAILED_CUSTOMER) as Error & {
            userFacingMessage: string;
          };
          err.userFacingMessage = RESEARCH_SYNTHESIS_FAILED_CUSTOMER;
          throw err;
        }
        // Salvage any valid items from the failed pack, then fall back to source quotes.
        extractionDegraded = true;
        extractedFindings = salvageExtractedFindings(extractResult.raw);
        logger.warn("Research findings extract failed after sources collected — degrading to source-backed partial", {
          researchJobId: jobId,
          organisationId: organisationId,
          reason: extractResult.reason,
          failureClass: extractResult.failureClass,
          sourceCount: ranked.length,
          salvagedCount: extractedFindings.length,
          phase: "STRUCTURED_EXTRACTION_FAILED",
        });
      }
    } else if (catalog) {
      extractionDegraded = true;
    }
    latency.extractMs = Date.now() - tExtract0;

    if (ranked.length > 0 && extractedFindings.length === 0) {
      extractionDegraded = true;
      extractedFindings = sourceBackedFindingsFromSources(ranked);
    }

    const normalizeUrlKey = (u: string) => {
      try {
        const parsed = new URL(u.trim());
        parsed.hash = "";
        const path = parsed.pathname.replace(/\/+$/, "") || "/";
        return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
      } catch {
        return u.trim().replace(/\/+$/, "");
      }
    };
    const allowedByNormalized = new Map(
      ranked.map((r) => [normalizeUrlKey(r.url), r.url] as const),
    );
    let findings = extractedFindings
      .map((f) => {
        const exact = allowedByNormalized.get(normalizeUrlKey(f.sourceUrl));
        return exact ? { ...f, sourceUrl: exact } : null;
      })
      .filter((f): f is NonNullable<typeof f> => f != null);

    if (ranked.length > 0 && extractedFindings.length > 0 && findings.length === 0) {
      extractionDegraded = true;
      logger.warn("Research findings had no usable source linkage — degrading to source-backed partial", {
        researchJobId: jobId,
        organisationId: organisationId,
        extractedCount: extractedFindings.length,
        phase: "GROUNDING_FAILED",
      });
      findings = sourceBackedFindingsFromSources(ranked);
    }

    const tPersistFindings0 = Date.now();
    await Promise.all(
      findings.map(async (f) => {
        const sourceId = urlToId.get(f.sourceUrl);
        if (!sourceId) return;
        await prisma.researchFinding.create({
          data: {
            organisationId: organisationId,
            researchJobId: jobId,
            researchSourceId: sourceId,
            claim: f.claim,
            evidenceExcerpt: f.evidenceExcerpt,
            claimKind: parseClaimKind(f.claimKind),
            confidence: f.confidence ?? null,
            freshnessScore: urlToFreshness.get(f.sourceUrl) ?? null,
          },
        });
      }),
    );
    latency.persistMs = persistSourcesMs + (Date.now() - tPersistFindings0);

    const unavailableNotes = formatUnavailableSourceNotes(adapterErrors);
    const authRequired = adapterErrors.find(
      (e) => e.code === "AUTH_REQUIRED" || (e.platform === "web" && e.code === "SOURCE_NOT_CONFIGURED"),
    );
    const missingWebKeys = !hasWebSearchCredentials() && ranked.length === 0;
    const emptyReason =
      authRequired?.message ||
      (missingWebKeys ? WEB_SEARCH_MISSING_KEY_MESSAGE : null) ||
      "No sources were returned from the configured adapters.";
    const baseSummary =
      findings.length > 0 && !extractionDegraded
        ? `Found ${findings.length} sourced finding${findings.length === 1 ? "" : "s"} from ${ranked.length} sources on ${topic}.`
        : findings.length > 0
          ? `Research gathered ${ranked.length} sources on ${topic}. Structured extraction was incomplete, so the findings below quote source titles and excerpts for verification — they are not fully synthesised claims.`
          : ranked.length > 0
            ? `Research gathered ${ranked.length} sources on ${topic}, but structured evidence extraction was incomplete — review the listed source URLs; claims are not fully verified.`
            : emptyReason;
    const summary = [baseSummary, ...unavailableNotes].join(" ").trim();
    const partialWithSources = ranked.length > 0 && (extractionDegraded || findings.length === 0);

    const jobError =
      ranked.length > 0 ? null : authRequired || missingWebKeys ? "AUTH_REQUIRED" : "no_sources";
    const output: ResearchOutput = {
      researchJobId: jobId,
      topic,
      queries,
      sourceCount: ranked.length,
      findings,
      sources: ranked.map((r) => ({
        url: r.url,
        title: r.title,
        platform: r.platform,
        listenChannel: labelResearchListenChannel(r.platform),
        snippet: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 280) || undefined,
        author: r.author ?? undefined,
      })),
      summary,
      adapterErrors: adapterErrors.slice(0, 20),
      ...(jobError ? { error: jobError } : {}),
      ...(partialWithSources
        ? {
            phase: "PARTIAL_WITH_SOURCES",
            caveats: [
              "Structured finding extraction did not complete — treat listed sources and quoted excerpts as leads for verification, not verified claims.",
            ],
          }
        : {}),
    };

    await updateOrgScopedById(prisma.researchJob, {
            id: jobId,
            organisationId,
            data: {
        status: ranked.length ? (findings.length && !extractionDegraded ? "COMPLETED" : "PARTIAL") : "FAILED",
        brief: output as unknown as Prisma.InputJsonValue,
        totalCostCents: costCents,
        finishedAt: new Date(),
        userFacingError: ranked.length
          ? null
          : jobError === "AUTH_REQUIRED"
            ? emptyReason
            : "I couldn't reach any research sources. Check that TAVILY_API_KEY or EXA_API_KEY is set on Vercel (Quick Ask runs there in-process), not only on the Railway worker.",
        // AUTH_REQUIRED is the ops-visible code for missing Vercel web keys
        // (production plant-hire jobs cmu149j980005la04wfakopf8 / cmu145m9g0005ic04zrfcgnzl
        // stored generic no_sources and looked like an adapter empty, not a key gap).
        error: jobError,
      },
          });

    if (ranked.length) {
      try {
        await recordMeteredUsage({
          organisationId: organisationId,
          feature: "research",
          metadata: { researchJobId: jobId },
        });
      } catch {
        /* metering must not fail the research output */
      }
      if (!fast && remainingMs() > 1_500) {
        try {
          await ingestResearchJobSocialContent({
            organisationId: organisationId,
            researchJobId: jobId,
          });
        } catch (error) {
          logger.warn("Social intelligence ingest skipped after research", {
            researchJobId: jobId,
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    }

    logger.info("Research latency budget", {
      jobId,
      expandMs: latency.expandMs,
      searchMs: latency.searchMs,
      extractMs: latency.extractMs,
      persistMs: latency.persistMs,
      totalMs: Date.now() - executeStarted,
      remainingMs: remainingMs(),
      ceilingMs: ownCeiling,
      depth,
      sourceCount: ranked.length,
      findingCount: findings.length,
      skipLlmExtract,
      degraded: ranked.length < 3 || extractionDegraded,
      extractionFailed: false,
      extractionDegraded,
    });

    return { output, model, costCents };
  },
};
