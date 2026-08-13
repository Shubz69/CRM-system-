import {
  SourceNotConfiguredError,
  SourceRateLimitError,
  type SourceAdapter,
  type SourceResult,
  type SourceSearchOptions,
} from "@/adapters/sources/types";
import { tryAcquireRateLimit } from "@/adapters/sources/rate-limit";
import {
  getCachedSourceResults,
  hashSourceQuery,
  setCachedSourceResults,
} from "@/adapters/sources/cache";
import { getEnv } from "@/lib/env";

type TokenCache = { accessToken: string; expiresAt: number };
let tokenCache: TokenCache | null = null;

function requireCreds(): { clientId: string; clientSecret: string; userAgent: string } {
  const env = getEnv();
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    throw new SourceNotConfiguredError(
      "reddit",
      "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not configured",
    );
  }
  return {
    clientId: env.REDDIT_CLIENT_ID,
    clientSecret: env.REDDIT_CLIENT_SECRET,
    userAgent: env.REDDIT_USER_AGENT || "agent-desk/0.1 (research agent)",
  };
}

function acquire(organisationId: string): void {
  const ok = tryAcquireRateLimit({
    key: `reddit:${organisationId}`,
    limit: Number(getEnv().REDDIT_RATE_LIMIT_PER_MIN || 60),
    windowMs: 60_000,
  });
  if (!ok) throw new SourceRateLimitError("reddit");
}

async function getAccessToken(): Promise<{ token: string; userAgent: string }> {
  const creds = requireCreds();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return { token: tokenCache.accessToken, userAgent: creds.userAgent };
  }
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": creds.userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reddit auth failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Reddit auth returned no access_token");
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return { token: json.access_token, userAgent: creds.userAgent };
}

async function redditGet<T>(path: string, params: Record<string, string>, orgId: string): Promise<T> {
  acquire(orgId);
  const { token, userAgent } = await getAccessToken();
  const url = new URL(`https://oauth.reddit.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reddit API ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const redditSourceAdapter: SourceAdapter = {
  platform: "reddit",
  displayName: "Reddit",

  async search(query, options: SourceSearchOptions): Promise<SourceResult[]> {
    requireCreds();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
    const cacheKey = hashSourceQuery({
      platform: "reddit",
      query,
      organisationId: options.organisationId,
      options: { limit, recent: options.recent ?? true, nicheHint: options.nicheHint },
    });
    const cached = getCachedSourceResults(cacheKey);
    if (cached) return cached.slice(0, limit);

    const subreddit = options.nicheHint?.replace(/^r\//i, "").trim();
    type Listing = {
      data?: {
        children?: Array<{
          data?: {
            id?: string;
            permalink?: string;
            title?: string;
            selftext?: string;
            author?: string;
            created_utc?: number;
            score?: number;
            num_comments?: number;
            ups?: number;
            subreddit?: string;
            url?: string;
          };
        }>;
      };
    };

    const listing = subreddit
      ? await redditGet<Listing>(
          `/r/${encodeURIComponent(subreddit)}/search`,
          {
            q: query,
            restrict_sr: "true",
            sort: options.recent === false ? "relevance" : "new",
            limit: String(limit),
            raw_json: "1",
          },
          options.organisationId,
        )
      : await redditGet<Listing>(
          `/search`,
          {
            q: query,
            sort: options.recent === false ? "relevance" : "new",
            limit: String(limit),
            raw_json: "1",
          },
          options.organisationId,
        );

    const results: SourceResult[] = [];
    for (const child of listing.data?.children || []) {
      const post = child.data;
      if (!post?.permalink) continue;
      const url = `https://www.reddit.com${post.permalink}`;

      let commentText = "";
      try {
        type CommentsListing = Array<{
          data?: {
            children?: Array<{
              data?: { body?: string; author?: string; score?: number };
            }>;
          };
        }>;
        const comments = await redditGet<CommentsListing>(
          `/comments/${post.id}`,
          { limit: "8", depth: "1", sort: "top", raw_json: "1" },
          options.organisationId,
        );
        const thread = comments[1]?.data?.children || [];
        commentText = thread
          .map((c) => c.data?.body)
          .filter((b): b is string => Boolean(b))
          .slice(0, 8)
          .join("\n---\n");
      } catch {
        // Thread fetch optional.
      }

      results.push({
        url,
        title: post.title || url,
        content: [post.selftext || "", commentText ? `Top comments:\n${commentText}` : ""]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 8000),
        author: post.author || null,
        publishedAt: post.created_utc ? new Date(post.created_utc * 1000) : null,
        platform: "reddit",
        engagement: {
          score: post.score,
          likes: post.ups,
          comments: post.num_comments,
        },
        rawMetadata: {
          id: post.id,
          subreddit: post.subreddit,
          externalUrl: post.url,
        },
      });
    }

    setCachedSourceResults(cacheKey, results);
    return results;
  },
};
