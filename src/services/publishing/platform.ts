import { SocialPlatform } from "@prisma/client";

/** Map PublishingJob.platform string → SocialPlatform enum (or null if unsupported). */
export function parseSocialPlatform(platform: string): SocialPlatform | null {
  const key = platform.trim().toUpperCase();
  if (key === "INSTAGRAM") return SocialPlatform.INSTAGRAM;
  if (key === "LINKEDIN") return SocialPlatform.LINKEDIN;
  if (key === "TIKTOK") return SocialPlatform.TIKTOK;
  return null;
}

export function connectorProviderKey(platform: SocialPlatform): string {
  switch (platform) {
    case SocialPlatform.INSTAGRAM:
      return "instagram";
    case SocialPlatform.LINKEDIN:
      return "linkedin";
    case SocialPlatform.TIKTOK:
      return "tiktok";
    default: {
      const _exhaustive: never = platform;
      return String(_exhaustive).toLowerCase();
    }
  }
}

export function publishOperationName(platform: SocialPlatform): string {
  switch (platform) {
    case SocialPlatform.INSTAGRAM:
      return "instagram.publish_post";
    case SocialPlatform.LINKEDIN:
      return "linkedin.publish_post";
    case SocialPlatform.TIKTOK:
      return "tiktok.publish_video";
    default: {
      const _exhaustive: never = platform;
      return `${String(_exhaustive).toLowerCase()}.publish`;
    }
  }
}

/** Stable idempotency key for a publish intent (org-scoped unique with PublishingJob). */
export function buildPublishIdempotencyKey(input: {
  organisationId: string;
  pieceId: string;
  platform: string;
  socialConnectionId?: string | null;
  scheduledAt?: Date | null;
  variantId?: string | null;
}): string {
  const sched = input.scheduledAt ? input.scheduledAt.toISOString() : "immediate";
  const conn = input.socialConnectionId ?? "none";
  const variant = input.variantId ?? "default";
  return [
    "publish",
    input.organisationId,
    input.pieceId,
    input.platform.toLowerCase(),
    conn,
    variant,
    sched,
  ].join(":");
}

/** Exact human-readable action string for approval UIs (bound to one job intent). */
export function formatPublishActionDescription(input: {
  platform: string;
  accountLabel: string;
  scheduledAt?: Date | null;
  pieceTitle?: string | null;
  jobId?: string | null;
}): string {
  const when = input.scheduledAt
    ? `scheduled for ${input.scheduledAt.toISOString()}`
    : "immediate (as soon as due)";
  const piece = input.pieceTitle?.trim()
    ? ` “${input.pieceTitle.trim().slice(0, 80)}”`
    : "";
  const job = input.jobId ? ` (job ${input.jobId})` : "";
  return `Publish${piece} to ${input.platform} account “${input.accountLabel}” (${when})${job}`;
}
