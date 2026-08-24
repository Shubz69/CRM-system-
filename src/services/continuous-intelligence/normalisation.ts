/**
 * Performance normalisation vs creator / account / format / platform baselines.
 * Audience size + content age aware. Raw views alone are never treated as sufficient.
 */

export type BaselineStats = {
  /** Median (or typical) absolute views in the baseline cohort. */
  medianViews?: number | null;
  /** Median engagement rate (engagements / audience) when available. */
  medianEngagementRate?: number | null;
  sampleSize: number;
};

export type NormalisationInput = {
  views: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  /** Content publish time — used for age-adjusted rate. */
  publishedAt?: Date | null;
  /** Observed / capture time (defaults to now). */
  asOf?: Date;
  /** Creator / account follower or reach estimate. */
  audienceSize?: number | null;
  creatorBaseline?: BaselineStats | null;
  accountBaseline?: BaselineStats | null;
  formatBaseline?: BaselineStats | null;
  platformBaseline?: BaselineStats | null;
};

export type NormalisationResult = {
  /** views / max(ageDays, 1) when views + publishedAt exist. */
  ageAdjustedViewsPerDay: number | null;
  /** (likes+comments+shares) / audienceSize when both exist. */
  audienceAdjustedRate: number | null;
  relativeToCreator: number | null;
  relativeToAccount: number | null;
  relativeToFormat: number | null;
  relativeToPlatform: number | null;
  /**
   * Composite only when at least one relative baseline OR audience-adjusted rate exists.
   * null when only raw views (or nothing) — never invent a score.
   */
  compositeIndex: number | null;
  gaps: string[];
  caution: string;
  sufficientForRelativeJudgement: boolean;
};

function contentAgeDays(publishedAt: Date | null | undefined, asOf: Date): number | null {
  if (!publishedAt) return null;
  const ms = asOf.getTime() - publishedAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(ms / (24 * 60 * 60 * 1000), 1 / 24); // floor ~1 hour
}

function relativeToBaseline(
  value: number | null,
  baseline: BaselineStats | null | undefined,
  field: "medianViews" | "medianEngagementRate",
): number | null {
  if (value == null || !baseline || baseline.sampleSize < 1) return null;
  const ref = baseline[field];
  if (ref == null || ref <= 0) return null;
  return value / ref;
}

/**
 * Compare a content observation against available baselines.
 * Does not invent missing baselines or treat raw views as performance proof.
 */
export function normalisePerformance(input: NormalisationInput): NormalisationResult {
  const asOf = input.asOf ?? new Date();
  const gaps: string[] = [];

  if (input.views == null) gaps.push("views_missing");
  if (input.audienceSize == null || input.audienceSize <= 0) gaps.push("audience_size_missing");
  if (!input.publishedAt) gaps.push("published_at_missing");
  if (!input.creatorBaseline || input.creatorBaseline.sampleSize < 1) {
    gaps.push("creator_baseline_unavailable");
  }
  if (!input.accountBaseline || input.accountBaseline.sampleSize < 1) {
    gaps.push("account_baseline_unavailable");
  }
  if (!input.formatBaseline || input.formatBaseline.sampleSize < 1) {
    gaps.push("format_baseline_unavailable");
  }
  if (!input.platformBaseline || input.platformBaseline.sampleSize < 1) {
    gaps.push("platform_baseline_unavailable");
  }

  const ageDays = contentAgeDays(input.publishedAt, asOf);
  const ageAdjustedViewsPerDay =
    input.views != null && ageDays != null ? input.views / ageDays : null;
  if (ageAdjustedViewsPerDay == null) gaps.push("age_adjusted_views_unavailable");

  const engagements =
    (input.likes ?? 0) + (input.comments ?? 0) + (input.shares ?? 0);
  const hasEngagementParts =
    input.likes != null || input.comments != null || input.shares != null;
  const audienceAdjustedRate =
    hasEngagementParts && input.audienceSize != null && input.audienceSize > 0
      ? engagements / input.audienceSize
      : null;
  if (audienceAdjustedRate == null) gaps.push("audience_adjusted_rate_unavailable");

  const relativeToCreator = relativeToBaseline(
    ageAdjustedViewsPerDay ?? input.views,
    input.creatorBaseline,
    "medianViews",
  );
  const relativeToAccount = relativeToBaseline(
    ageAdjustedViewsPerDay ?? input.views,
    input.accountBaseline,
    "medianViews",
  );
  const relativeToFormat = relativeToBaseline(
    ageAdjustedViewsPerDay ?? input.views,
    input.formatBaseline,
    "medianViews",
  );
  const relativeToPlatform = relativeToBaseline(
    ageAdjustedViewsPerDay ?? input.views,
    input.platformBaseline,
    "medianViews",
  );

  const relatives = [
    relativeToCreator,
    relativeToAccount,
    relativeToFormat,
    relativeToPlatform,
  ].filter((v): v is number => v != null);

  const sufficientForRelativeJudgement =
    relatives.length > 0 || audienceAdjustedRate != null;

  let compositeIndex: number | null = null;
  if (sufficientForRelativeJudgement) {
    const parts: number[] = [...relatives];
    if (audienceAdjustedRate != null) {
      // Scale engagement rate into a comparable ~0–few range vs median rate when present.
      const rateRefs = [
        input.creatorBaseline?.medianEngagementRate,
        input.accountBaseline?.medianEngagementRate,
        input.formatBaseline?.medianEngagementRate,
        input.platformBaseline?.medianEngagementRate,
      ].filter((v): v is number => v != null && v > 0);
      if (rateRefs.length) {
        const meanRef = rateRefs.reduce((a, b) => a + b, 0) / rateRefs.length;
        parts.push(audienceAdjustedRate / meanRef);
      } else {
        // No rate baseline — include raw rate lightly so views alone still aren't the only signal.
        parts.push(Math.min(audienceAdjustedRate * 100, 5));
      }
    }
    compositeIndex = parts.reduce((a, b) => a + b, 0) / parts.length;
  }

  const caution = sufficientForRelativeJudgement
    ? "Relative index from available baselines / audience rate — not a virality probability."
    : "Insufficient context: raw views alone are not enough for relative performance judgement.";

  return {
    ageAdjustedViewsPerDay,
    audienceAdjustedRate,
    relativeToCreator,
    relativeToAccount,
    relativeToFormat,
    relativeToPlatform,
    compositeIndex,
    gaps,
    caution,
    sufficientForRelativeJudgement,
  };
}

/**
 * Build crude baselines from a list of view observations (caller supplies cohort).
 * Returns null sample when empty — never fabricates medians.
 */
export function buildBaselineFromViews(views: Array<number | null | undefined>): BaselineStats {
  const nums = views.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!nums.length) return { medianViews: null, sampleSize: 0 };
  const mid = Math.floor(nums.length / 2);
  const medianViews =
    nums.length % 2 === 0 ? (nums[mid - 1]! + nums[mid]!) / 2 : nums[mid]!;
  return { medianViews, sampleSize: nums.length };
}
