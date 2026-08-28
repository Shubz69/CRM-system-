import { prisma } from "@/lib/db";

export const EXTRACTOR_VERSION = "features-v1";
export const creativeGenomeEnabled = true;

const PATTERN_FEATURES = ["topic", "hookType", "format", "platform"] as const;
type PatternFeature = (typeof PATTERN_FEATURES)[number];
type FeatureCombo = Partial<Record<PatternFeature, string>>;

type CreativeFeatureRow = {
  contentVersionId: string | null;
  [key: string]: unknown;
};

type CreativeGenomeDb = {
  creativeFeatureSet: {
    findUnique(args: unknown): Promise<CreativeFeatureRow | null>;
    upsert(args: unknown): Promise<CreativeFeatureRow>;
  };
  creativePattern: {
    upsert(args: unknown): Promise<unknown>;
  };
};

const db = prisma as unknown as CreativeGenomeDb;

export type ExtractCreativeFeaturesInput = {
  organisationId: string;
  contentPieceId: string;
  contentVersionId?: string | null;
  text: string;
  platform?: string | null;
  format?: string | null;
  topic?: string | null;
  scheduledAt?: Date | string | null;
  hookType?: string | null;
  angle?: string | null;
  tone?: string | null;
  ctaType?: string | null;
  audienceKey?: string | null;
  campaignId?: string | null;
  goalId?: string | null;
};

const CTA_PATTERN =
  /\b(?:book|buy|comment|contact|download|follow|join|learn more|register|reply|save|share|shop|sign up|subscribe|try|visit)\b/i;

function postingWindow(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hour = date.getUTCHours();
  if (hour < 6) return "OVERNIGHT";
  if (hour < 12) return "MORNING";
  if (hour < 17) return "AFTERNOON";
  if (hour < 22) return "EVENING";
  return "OVERNIGHT";
}

export function deriveCreativeFeatures(input: ExtractCreativeFeaturesInput) {
  return {
    platform: input.platform ?? null,
    format: input.format ?? null,
    topic: input.topic ?? null,
    hookType: input.hookType ?? null,
    angle: input.angle ?? null,
    tone: input.tone ?? null,
    lengthChars: input.text.length,
    ctaPresent: CTA_PATTERN.test(input.text),
    ctaType: input.ctaType ?? null,
    postingWindow: postingWindow(input.scheduledAt),
    audienceKey: input.audienceKey ?? null,
    campaignId: input.campaignId ?? null,
    goalId: input.goalId ?? null,
  };
}

/**
 * Extracts deterministic features once per extractor/content version. Semantic
 * fields are accepted only as upstream evidence; this function never invokes AI.
 */
export async function extractCreativeFeatures(input: ExtractCreativeFeaturesInput) {
  const where = {
    organisationId_contentPieceId_extractorVersion: {
      organisationId: input.organisationId,
      contentPieceId: input.contentPieceId,
      extractorVersion: EXTRACTOR_VERSION,
    },
  };
  const existing = await db.creativeFeatureSet.findUnique({ where });
  const contentVersionId = input.contentVersionId ?? null;
  if (existing && existing.contentVersionId === contentVersionId) return existing;

  const extracted = deriveCreativeFeatures(input);
  const data = {
    organisationId: input.organisationId,
    contentPieceId: input.contentPieceId,
    contentVersionId,
    extractorVersion: EXTRACTOR_VERSION,
    ...extracted,
    features: {
      source: "deterministic",
      semanticFieldsProvided: ["hookType", "angle", "tone"].filter(
        (key) => input[key as "hookType" | "angle" | "tone"] != null,
      ),
    },
    extractedAt: new Date(),
  };
  return db.creativeFeatureSet.upsert({
    where,
    create: data,
    update: data,
  });
}

export function buildFeatureCombos(features: FeatureCombo): FeatureCombo[] {
  const present = PATTERN_FEATURES.filter((key) => Boolean(features[key]));
  const combos: FeatureCombo[] = present.map((key) => ({ [key]: features[key] }));
  for (let left = 0; left < present.length; left += 1) {
    for (let right = left + 1; right < present.length; right += 1) {
      const a = present[left]!;
      const b = present[right]!;
      combos.push({ [a]: features[a], [b]: features[b] });
    }
  }
  return combos;
}

export function creativePatternMaturity(sampleSize: number) {
  if (sampleSize < 5) return "INSUFFICIENT_DATA" as const;
  if (sampleSize < 15) return "EMERGING_PATTERN" as const;
  if (sampleSize < 40) return "SUPPORTED_PATTERN" as const;
  return "STRONG_PATTERN" as const;
}

export function creativePatternKey(featureCombo: FeatureCombo): string {
  const entries = Object.entries(featureCombo)
    .filter(([key, value]) => PATTERN_FEATURES.includes(key as PatternFeature) && Boolean(value))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1 || entries.length > 2) {
    throw new Error("Creative patterns support one feature or one feature pair");
  }
  return entries.map(([key, value]) => `${key}=${String(value)}`).join("|");
}

type PatternMetrics = {
  views?: number;
  qualifiedEngagements?: number;
  qualifiedEngagementRate?: number;
  leads?: number;
  conversions?: number;
  replies?: number;
  saves?: number;
  shares?: number;
};

export function normalisePatternMetrics(metrics: PatternMetrics) {
  const hasQualifiedSignal = [
    metrics.qualifiedEngagements,
    metrics.qualifiedEngagementRate,
    metrics.leads,
    metrics.conversions,
    metrics.replies,
    metrics.saves,
    metrics.shares,
  ].some((value) => typeof value === "number");
  return {
    ...metrics,
    optimisationBasis: hasQualifiedSignal ? "QUALIFIED_ENGAGEMENT" : "INSUFFICIENT_QUALIFIED_DATA",
    bestFormatEligible: hasQualifiedSignal,
    caution: hasQualifiedSignal
      ? null
      : "Views alone do not establish a best-performing creative format.",
  };
}

export async function upsertCreativePattern(input: {
  organisationId: string;
  featureCombo: FeatureCombo;
  sampleSize: number;
  metrics?: PatternMetrics;
}) {
  const patternKey = creativePatternKey(input.featureCombo);
  const sampleSize = Math.max(0, Math.trunc(input.sampleSize));
  const data = {
    featureCombo: input.featureCombo,
    sampleSize,
    maturity: creativePatternMaturity(sampleSize),
    metrics: normalisePatternMetrics(input.metrics ?? {}),
  };
  return db.creativePattern.upsert({
    where: {
      organisationId_patternKey: {
        organisationId: input.organisationId,
        patternKey,
      },
    },
    create: {
      organisationId: input.organisationId,
      patternKey,
      ...data,
    },
    update: data,
  });
}

const MATURITY_LABEL: Record<string, string> = {
  INSUFFICIENT_DATA: "Insufficient data",
  EMERGING_PATTERN: "Early pattern",
  SUPPORTED_PATTERN: "Supported pattern",
  STRONG_PATTERN: "Strong pattern",
};

const FEATURE_LABEL: Record<string, string> = {
  hookType: "Hook type",
  topic: "Topic",
  format: "Format",
  platform: "Platform",
  ctaType: "Call to action",
};

/** Customer-facing creative patterns — never invents when sample size is too low. */
export async function listCreativePatternsForDisplay(organisationId: string) {
  const rows = await prisma.creativePattern.findMany({
    where: { organisationId },
    orderBy: [{ sampleSize: "desc" }, { updatedAt: "desc" }],
    take: 40,
  });

  return rows.map((row) => {
    const combo =
      row.featureCombo && typeof row.featureCombo === "object" && !Array.isArray(row.featureCombo)
        ? (row.featureCombo as Record<string, string>)
        : {};
    const parts = Object.entries(combo)
      .filter(([, v]) => Boolean(v))
      .map(([k, v]) => `${FEATURE_LABEL[k] ?? k}: ${v}`);
    return {
      id: row.id,
      label: parts.join(" · ") || row.patternKey,
      sampleSize: row.sampleSize,
      maturity: row.maturity,
      maturityLabel: MATURITY_LABEL[row.maturity] ?? "Insufficient data",
      /** Only surface as a recommendation when sample thresholds clear early stage. */
      showAsRecommendation: row.sampleSize >= 5 && row.maturity !== "INSUFFICIENT_DATA",
    };
  });
}
