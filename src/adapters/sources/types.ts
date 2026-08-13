export type SourcePlatform =
  | "youtube"
  | "reddit"
  | "web"
  | "instagram"
  | "linkedin"
  | "tiktok";

export type SourceEngagement = {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  score?: number;
  subscribers?: number;
  raw?: Record<string, unknown>;
};

export type SourceResult = {
  url: string;
  title: string;
  content: string;
  author: string | null;
  publishedAt: Date | null;
  platform: SourcePlatform;
  engagement: SourceEngagement | null;
  rawMetadata: Record<string, unknown>;
};

export type SourceSearchOptions = {
  organisationId: string;
  /** Max results to return (adapter may return fewer). */
  limit?: number;
  /** Prefer recent content when the API supports it. */
  recent?: boolean;
  /** Optional subreddit / channel / site hint — never required. */
  nicheHint?: string;
};

export type SourceAdapter = {
  readonly platform: SourcePlatform;
  readonly displayName: string;
  /**
   * Search the platform. Must throw SourceNotConfiguredError when credentials
   * are missing — never invent results.
   */
  search(query: string, options: SourceSearchOptions): Promise<SourceResult[]>;
};

export class SourceNotConfiguredError extends Error {
  readonly code = "SOURCE_NOT_CONFIGURED";
  constructor(
    readonly platform: SourcePlatform,
    message?: string,
  ) {
    super(
      message ||
        `${platform} source adapter is not configured. Set the required API credentials, or remove it from the search plan.`,
    );
    this.name = "SourceNotConfiguredError";
  }
}

export class SourceRateLimitError extends Error {
  readonly code = "SOURCE_RATE_LIMITED";
  constructor(
    readonly platform: SourcePlatform,
    message?: string,
  ) {
    super(message || `${platform} rate limit exceeded`);
    this.name = "SourceRateLimitError";
  }
}
