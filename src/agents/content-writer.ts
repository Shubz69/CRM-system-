import { z } from "zod";
import type { Agent } from "@/agents/types";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import { hasWebSearchCredentials, webSourceAdapter } from "@/adapters/sources/web";
import type { SourceResult } from "@/adapters/sources/types";
import { raceWithTimeout } from "@/agents/supervisor/research-deadline";
import { resolveModelForTier } from "@/lib/ai-models";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getBusinessProfile } from "@/services/digital-twin";
import { assertEntitlement } from "@/services/entitlements";
import { retrieveRelevantKnowledge } from "@/services/knowledge";

/** Optional web scan must never hold the draft hostage. */
const CONTENT_RESEARCH_TIMEOUT_MS = 6_000;

export const contentWriterInputSchema = z.object({
  request: z.string().min(3).max(4000),
  /** false = never attempt web research (draft from business context only). */
  useResearch: z.boolean().optional(),
});

const contentDraftSchema = z.object({
  hook: z.string().min(3).max(200).optional(),
  caption: z.string().min(40).max(2200),
  hashtags: z.array(z.string().min(2).max(60)).max(15).optional(),
  callToAction: z.string().min(3).max(240).optional(),
  imageIdea: z.string().min(3).max(300).optional(),
});

export const contentWriterOutputSchema = z.object({
  /** Built from this workspace's own business context — not a web-research answer. */
  source: z.literal("workspace_content"),
  format: z.string(),
  topic: z.string(),
  shortAnswer: z.string(),
  summary: z.string(),
  draft: contentDraftSchema,
  generatedBy: z.enum(["ai", "template"]),
  researchUsed: z.boolean(),
  researchNote: z.string(),
  businessContextUsed: z.array(z.string()),
  sources: z.array(z.object({ url: z.string(), title: z.string(), platform: z.string() })).optional(),
});

export type ContentWriterInput = z.infer<typeof contentWriterInputSchema>;
export type ContentWriterOutput = z.infer<typeof contentWriterOutputSchema>;
type ContentDraft = z.infer<typeof contentDraftSchema>;

export type ContentFormat = "instagram_post" | "caption" | "reel_script" | "carousel" | "story" | "email";

const FORMAT_LABEL: Record<ContentFormat, string> = {
  instagram_post: "Instagram post",
  caption: "Caption",
  reel_script: "Reel script",
  carousel: "Carousel post",
  story: "Story",
  email: "Email",
};

export function detectContentFormat(request: string): ContentFormat {
  const t = request.toLowerCase();
  if (/\b(reels?|tiktok|video script|script)\b/.test(t)) return "reel_script";
  if (/\bcarousel\b/.test(t)) return "carousel";
  if (/\bstor(y|ies)\b/.test(t)) return "story";
  if (/\b(email|newsletter)\b/.test(t)) return "email";
  if (/\bcaption\b/.test(t)) return "caption";
  return "instagram_post";
}

/** "Write an Instagram post about our bridal hair packages" → "our bridal hair packages". */
export function extractContentTopic(request: string): string {
  let t = request.trim().replace(/\s+/g, " ");
  const quoted = t.match(/[“"]([^”"]{3,})[”"]/);
  if (quoted?.[1]) return quoted[1].trim();
  t = t.replace(
    /^(please\s+)?(can you\s+|could you\s+)?(write|draft|compose|craft|create|make|give me|come up with|rewrite)\s+(me\s+|us\s+)?(an?\s+|some\s+|the\s+|\d+\s+)?((instagram|ig|insta|facebook|tiktok|social( media)?|short|quick|fun|new)\s+)*(posts?|captions?|content|copy|reel scripts?|scripts?|reels?|carousels?|stor(y|ies)|blogs?( posts?)?|newsletters?|emails?|ad copy|ads?|announcements?|promos?)?\s*/i,
    "",
  );
  t = t.replace(/^(about|on|for|promoting|announcing|around|based on)\s+/i, "");
  t = t.replace(/[\s.!?:]+$/, "").trim();
  return t.slice(0, 200);
}

type ProductLite = {
  name: string;
  description: string | null;
  category: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  currency: string | null;
};

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["our", "the", "and", "for", "with", "about", "your", "new"].includes(w));
}

function stem(word: string): string {
  return word.replace(/(es|s)$/, "");
}

/**
 * Offerings that genuinely match the topic: a topic word in the offering name, or
 * several in its description. Never falls back to an unrelated offering.
 */
export function pickRelevantProducts(topic: string, products: ProductLite[]): ProductLite[] {
  const want = new Set(tokens(topic).map(stem));
  const seen = new Set<string>();
  return products
    .filter((p) => {
      const key = p.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => {
      const nameHits = tokens(p.name).map(stem).filter((w) => want.has(w)).length;
      const restHits = tokens(`${p.description ?? ""} ${p.category ?? ""}`)
        .map(stem)
        .filter((w) => want.has(w)).length;
      return { p, nameHits, score: nameHits * 2 + restHits };
    })
    .filter((s) => s.nameHits > 0 || s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.p)
    .slice(0, 2);
}

/** Knowledge sentences that talk about the topic (approved docs only — quotable facts). */
export function pickKnowledgeLines(topic: string, chunks: string[]): string[] {
  const want = new Set(tokens(topic).map(stem));
  if (!want.size) return [];
  const need = want.size >= 2 ? 2 : 1;
  const scored: Array<{ line: string; score: number }> = [];
  for (const chunk of chunks) {
    for (const raw of chunk.split(/(?<=[.!?])\s+|\n+/)) {
      const line = raw.replace(/^[QA]:\s*/i, "").replace(/\s+/g, " ").trim();
      if (line.length < 15 || line.length > 220) continue;
      const score = new Set(tokens(line).map(stem).filter((w) => want.has(w))).size;
      if (score >= need) scored.push({ line, score });
    }
  }
  return [...new Set(scored.sort((a, b) => b.score - a.score).map((s) => s.line))].slice(0, 2);
}

function priceText(p: ProductLite): string | null {
  const symbol = !p.currency || p.currency === "GBP" ? "£" : `${p.currency} `;
  const fmt = (c: number) => `${symbol}${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
  if (p.priceMinCents != null && p.priceMaxCents != null && p.priceMaxCents > p.priceMinCents) {
    return `${fmt(p.priceMinCents)}–${fmt(p.priceMaxCents)}`;
  }
  if (p.priceMinCents != null) return `from ${fmt(p.priceMinCents)}`;
  if (p.priceMaxCents != null) return `up to ${fmt(p.priceMaxCents)}`;
  return null;
}

function firstSentence(text: string | null | undefined, max = 160): string | null {
  if (!text?.trim()) return null;
  const s = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function hashtagify(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const tag = w.replace(/[^a-z0-9]/gi, "");
    if (tag.length < 3) continue;
    const h = `#${tag.toLowerCase()}`;
    if (!out.includes(h)) out.push(h);
    if (out.length >= 6) break;
  }
  return out;
}

export type ContentBusinessContext = {
  orgName: string;
  whatWeDo: string | null;
  location: string | null;
  /** Offerings that match the topic (may be empty — never an unrelated offering). */
  products: ProductLite[];
  /** Other offerings on file — AI context only, never presented as the topic. */
  otherProducts: ProductLite[];
  audiences: string[];
  brandTone: string | null;
  emojiUsage: string | null;
  bookingUrl: string | null;
  /** Approved Knowledge chunks relevant to the topic. */
  knowledgeSnippets: string[];
  /** Knowledge sentences that mention the topic — safe to quote in a template draft. */
  knowledgeLines: string[];
};

/**
 * Deterministic draft from business context — used when the AI adapter is
 * unavailable or returns something unusable. Never invents prices or claims.
 */
export function buildTemplateDraft(input: {
  topic: string;
  format: ContentFormat;
  ctx: ContentBusinessContext;
}): ContentDraft {
  const { ctx } = input;
  const topic = input.topic || ctx.products[0]?.name || "what we do";
  const topicPhrase = topic.replace(/^(our|my)\s+/i, "");
  const emoji = ctx.emojiUsage && /none|no/i.test(ctx.emojiUsage) ? "" : " ✨";
  const product = ctx.products[0];
  const price = product ? priceText(product) : null;
  const productLine = product
    ? `Our ${product.name}${price ? ` (${price})` : ""}${
        firstSentence(product.description) ? ` — ${firstSentence(product.description)!.replace(/\.$/, "")}` : ""
      }.`
    : `At ${ctx.orgName}, we offer ${topicPhrase}. Message us about what you have in mind and we'll tailor it to you.`;
  const factLines = ctx.knowledgeLines.slice(0, 2);
  const audience = ctx.audiences[0]?.replace(/\.$/, "");
  const audienceLine = audience ? `Made for ${audience.charAt(0).toLowerCase()}${audience.slice(1)}.` : null;
  const placeLine = ctx.location ? `Based in ${ctx.location}.` : null;
  const hook = `Thinking about ${topicPhrase}?${emoji}`;
  const callToAction = ctx.bookingUrl
    ? "DM us to check availability or book through the link in our bio."
    : "DM us to check availability and get your date in the diary.";
  const caption = [hook, "", productLine, ...factLines, audienceLine, placeLine, "", callToAction]
    .filter((l): l is string => l != null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const hashtags = hashtagify([
    ...tokens(topicPhrase),
    ...(ctx.location ? [ctx.location] : []),
    ctx.orgName,
  ]);
  return {
    hook,
    caption,
    hashtags,
    callToAction,
    imageIdea: product
      ? `A bright, natural-light photo of a real ${product.name.toLowerCase()} result from ${ctx.orgName}.`
      : `A natural-light photo that shows ${topicPhrase} at ${ctx.orgName}.`,
  };
}

function formatDraftSummary(input: {
  format: ContentFormat;
  topic: string;
  draft: ContentDraft;
  generatedBy: "ai" | "template";
  researchNote: string;
  businessContextUsed: string[];
}): string {
  const { draft } = input;
  const lines = [`${FORMAT_LABEL[input.format].toUpperCase()} — draft (not posted)`, "", draft.caption.trim()];
  if (draft.hashtags?.length) lines.push("", draft.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "));
  if (draft.callToAction && !draft.caption.includes(draft.callToAction)) {
    lines.push("", `Call to action: ${draft.callToAction}`);
  }
  if (draft.imageIdea) lines.push(`Image idea: ${draft.imageIdea}`);
  lines.push(
    "",
    `Built from: ${input.businessContextUsed.length ? input.businessContextUsed.join("; ") : "your request (Business Profile is empty — add offerings and audiences for sharper drafts)"}.`,
    input.researchNote,
  );
  if (input.generatedBy === "template") {
    lines.push("AI writing wasn't available, so this is a template draft from your business profile — edit before posting.");
  }
  return lines.join("\n");
}

/**
 * Business Profile, brand tone and approved Knowledge for this org. Deliberately not
 * the supervisor's knowledgeContext: that also carries episodic memory (earlier Ask
 * answers), which must not be recycled into a quoted "fact".
 */
async function loadBusinessContext(organisationId: string, topic: string): Promise<ContentBusinessContext> {
  const [profile, config, knowledge] = await Promise.all([
    getBusinessProfile(organisationId).catch(() => null),
    prisma.agentConfiguration
      .findFirst({
        where: { organisationId, isActive: true, isDraft: false },
        orderBy: { updatedAt: "desc" },
        select: { brandTone: true, emojiUsage: true, bookingUrl: true },
      })
      .catch(() => null),
    retrieveRelevantKnowledge({ organisationId, query: topic || "products and services", limit: 4 }).catch(
      () => null,
    ),
  ]);
  const claims = (profile?.claims ?? []) as Array<{ predicate?: string | null; valueText?: string | null }>;
  const claim = (re: RegExp) => claims.find((c) => re.test(String(c.predicate || "")))?.valueText?.trim() || null;
  const products = ((profile?.products ?? []) as ProductLite[]).filter(
    (p) => p.name?.trim() && !/^primary offering$/i.test(p.name),
  );
  const audiences = ((profile?.audiences ?? []) as Array<{ name?: string | null; description?: string | null }>)
    .map((a) => String(a.name || "").trim())
    .filter((n) => n && !/^primary audience$/i.test(n));
  const chunks = (knowledge?.chunks ?? []).map((c) => c.trim()).filter(Boolean);
  const relevant = pickRelevantProducts(topic, products);
  const relevantNames = new Set(relevant.map((p) => p.name.trim().toLowerCase()));
  const others = products
    .filter((p, i, all) => all.findIndex((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase()) === i)
    .filter((p) => !relevantNames.has(p.name.trim().toLowerCase()))
    .slice(0, 3);
  return {
    orgName: profile?.organisation?.name || "our business",
    whatWeDo: claim(/what_we_do|what you do|business_description/i),
    location: claim(/location|city|service_area|based_in/i),
    products: relevant,
    otherProducts: others,
    audiences: [...new Set(audiences)].slice(0, 2),
    brandTone: config?.brandTone ?? null,
    emojiUsage: config?.emojiUsage ?? null,
    bookingUrl: config?.bookingUrl ?? null,
    knowledgeSnippets: chunks.map((c) => c.replace(/\s+/g, " ").slice(0, 500)).slice(0, 3),
    knowledgeLines: pickKnowledgeLines(topic, chunks),
  };
}

async function quickResearch(organisationId: string, topic: string, allowed: boolean | undefined): Promise<{
  used: boolean;
  note: string;
  results: SourceResult[];
}> {
  const notUsed = (why: string) => ({
    used: false,
    note: `Research: not used — ${why}, so this draft is written from your business context only.`,
    results: [] as SourceResult[],
  });
  if (allowed === false) return notUsed("research was switched off for this draft");
  if (!hasWebSearchCredentials()) return notUsed("web research isn't available for this workspace");
  try {
    await assertEntitlement(organisationId, "research");
  } catch {
    return notUsed("research isn't included in this workspace's plan");
  }
  try {
    const results = await raceWithTimeout(
      webSourceAdapter.search(`${topic} ideas trends`, {
        organisationId,
        limit: 4,
        recent: true,
        answerMode: "QUICK",
        qualityBudget: "FAST",
      }),
      CONTENT_RESEARCH_TIMEOUT_MS,
      () => [] as SourceResult[],
    );
    const usable = results.filter((r) => r.url && (r.content?.trim() || r.title?.trim())).slice(0, 3);
    if (!usable.length) return notUsed("the quick web scan returned nothing usable");
    return {
      used: true,
      note: `Research: light web scan used for current angles (${usable.length} source${usable.length === 1 ? "" : "s"} below) — check any facts before posting.`,
      results: usable,
    };
  } catch (error) {
    logger.warn("Content writer research skipped", {
      organisationId,
      message: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    return notUsed("the quick web scan failed");
  }
}

/**
 * Writes posts / captions / scripts in the workspace's voice from its Business
 * Profile, offerings, audiences, knowledge and brand tone. Web research is an
 * optional extra — never a dependency.
 */
export const contentWriterAgent: Agent<ContentWriterInput, ContentWriterOutput> = {
  name: "content_writer",
  description:
    "Writes social posts, captions, scripts and emails in the business's voice from its Business Profile, offerings, audiences and knowledge (web research optional).",
  inputSchema: contentWriterInputSchema,
  outputSchema: contentWriterOutputSchema,
  tier: "balanced",
  estimateCostCents: () => 2,
  userFacingLabel: (input) => {
    const format = FORMAT_LABEL[detectContentFormat(input.request || "")].toLowerCase();
    const topic = extractContentTopic(input.request || "");
    return topic ? `Writing your ${format} about “${topic.slice(0, 60)}”` : `Writing your ${format}`;
  },
  async execute(input, ctx) {
    const parsed = contentWriterInputSchema.parse(input);
    const format = detectContentFormat(parsed.request);
    const topic = extractContentTopic(parsed.request);

    const [biz, research] = await Promise.all([
      loadBusinessContext(ctx.organisationId, topic),
      quickResearch(ctx.organisationId, topic || parsed.request.slice(0, 120), parsed.useResearch),
    ]);

    const businessContextUsed = [
      biz.orgName !== "our business" ? `Business Profile (${biz.orgName})` : null,
      biz.products.length ? `offerings: ${biz.products.map((p) => p.name).join(", ")}` : null,
      biz.audiences.length ? `audiences: ${biz.audiences.join(", ")}` : null,
      biz.brandTone ? `brand tone “${biz.brandTone}”` : null,
      biz.knowledgeSnippets.length ? "approved Knowledge" : null,
    ].filter((x): x is string => Boolean(x));

    const model = resolveModelForTier("balanced");
    let draft: ContentDraft | null = null;
    let generatedBy: "ai" | "template" = "template";
    try {
      const result = await completeStructuredSafe(contentDraftSchema, {
        organisationId: ctx.organisationId,
        tier: "balanced",
        model,
        temperature: 0.7,
        skipRepair: true,
        maxTokens: 1500,
        system: [
          `You write ${FORMAT_LABEL[format]} copy for ${biz.orgName}, a small business that sells through Instagram DMs.`,
          `Brand tone: ${biz.brandTone || "warm, friendly, professional"}. Emoji usage: ${biz.emojiUsage || "minimal"}.`,
          "Use ONLY the business facts given. Never invent prices, awards, statistics, guarantees or testimonials.",
          "End with a clear call to action that invites a DM or booking. Keep hashtags relevant and few.",
        ].join("\n"),
        prompt: [
          `Request: ${parsed.request}`,
          `Topic: ${topic || "the business"}`,
          `Business: ${biz.orgName}${biz.location ? ` (${biz.location})` : ""}`,
          biz.whatWeDo ? `What we do: ${biz.whatWeDo}` : null,
          biz.products.length
            ? `Relevant offerings:\n${biz.products
                .map((p) => `- ${p.name}${priceText(p) ? ` (${priceText(p)})` : ""}${p.description ? `: ${p.description.slice(0, 300)}` : ""}`)
                .join("\n")}`
            : "Relevant offerings: none on file for this topic — keep claims general, never invent prices.",
          biz.otherProducts.length
            ? `Other offerings (context only — do not present them as the topic): ${biz.otherProducts.map((p) => p.name).join("; ")}`
            : null,
          biz.audiences.length ? `Audiences: ${biz.audiences.join("; ")}` : null,
          biz.bookingUrl ? "Booking: link in bio." : null,
          biz.knowledgeSnippets.length ? `Knowledge (internal, may quote facts):\n${biz.knowledgeSnippets.join("\n").slice(0, 2000)}` : null,
          research.used
            ? `Current web angles (optional inspiration, do not copy):\n${research.results
                .map((r) => `- ${r.title}: ${(r.content || "").replace(/\s+/g, " ").slice(0, 240)}`)
                .join("\n")}`
            : null,
          'Return JSON: {"hook": string, "caption": string (the full post text), "hashtags": string[], "callToAction": string, "imageIdea": string}',
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      if (result.ok) {
        draft = result.data;
        generatedBy = "ai";
      }
    } catch (error) {
      logger.warn("Content writer AI draft failed; using template", {
        organisationId: ctx.organisationId,
        message: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
    }
    if (!draft) {
      draft = buildTemplateDraft({ topic, format, ctx: biz });
    }

    const summary = formatDraftSummary({
      format,
      topic,
      draft,
      generatedBy,
      researchNote: research.note,
      businessContextUsed,
    });
    const output: ContentWriterOutput = {
      source: "workspace_content",
      format,
      topic: topic || biz.orgName,
      shortAnswer: `${FORMAT_LABEL[format]} draft about ${topic || biz.orgName} — ${
        research.used ? "with light web research" : "written from your business context (no web research)"
      }.`,
      summary,
      draft,
      generatedBy,
      researchUsed: research.used,
      researchNote: research.note,
      businessContextUsed,
      ...(research.used
        ? {
            sources: research.results.map((r) => ({ url: r.url, title: r.title || r.url, platform: r.platform })),
          }
        : {}),
    };
    return { output, model: generatedBy === "ai" ? model : undefined, costCents: generatedBy === "ai" ? 2 : 0 };
  },
};
