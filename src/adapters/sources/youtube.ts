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

const YT_SEARCH = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS = "https://www.googleapis.com/youtube/v3/videos";
const YT_CHANNELS = "https://www.googleapis.com/youtube/v3/channels";
const YT_COMMENTS = "https://www.googleapis.com/youtube/v3/commentThreads";

function requireKey(): string {
  const key = getEnv().YOUTUBE_API_KEY;
  if (!key) throw new SourceNotConfiguredError("youtube", "YOUTUBE_API_KEY is not configured");
  return key;
}

function acquire(organisationId: string): void {
  // YouTube quota is daily; keep a conservative per-org RPM guard.
  const ok = tryAcquireRateLimit({
    key: `youtube:${organisationId}`,
    limit: Number(getEnv().YOUTUBE_RATE_LIMIT_PER_MIN || 30),
    windowMs: 60_000,
  });
  if (!ok) throw new SourceRateLimitError("youtube");
}

async function ytGet<T>(url: string, params: Record<string, string>): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const youtubeSourceAdapter: SourceAdapter = {
  platform: "youtube",
  displayName: "YouTube",

  async search(query, options: SourceSearchOptions): Promise<SourceResult[]> {
    const apiKey = requireKey();
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
    const cacheKey = hashSourceQuery({
      platform: "youtube",
      query,
      organisationId: options.organisationId,
      options: { limit, recent: options.recent ?? true, nicheHint: options.nicheHint },
    });
    const cached = getCachedSourceResults(cacheKey);
    if (cached) return cached.slice(0, limit);

    acquire(options.organisationId);

    const searchParams: Record<string, string> = {
      key: apiKey,
      part: "snippet",
      type: "video",
      q: options.nicheHint ? `${query} ${options.nicheHint}` : query,
      maxResults: String(limit),
      order: options.recent === false ? "relevance" : "date",
    };

    type SearchResp = {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: {
          title?: string;
          description?: string;
          channelTitle?: string;
          channelId?: string;
          publishedAt?: string;
        };
      }>;
    };

    const search = await ytGet<SearchResp>(YT_SEARCH, searchParams);
    const videoIds = (search.items || [])
      .map((i) => i.id?.videoId)
      .filter((id): id is string => Boolean(id));

    if (!videoIds.length) {
      setCachedSourceResults(cacheKey, []);
      return [];
    }

    acquire(options.organisationId);
    type VideosResp = {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          description?: string;
          channelTitle?: string;
          channelId?: string;
          publishedAt?: string;
        };
        statistics?: {
          viewCount?: string;
          likeCount?: string;
          commentCount?: string;
        };
      }>;
    };
    const videos = await ytGet<VideosResp>(YT_VIDEOS, {
      key: apiKey,
      part: "snippet,statistics",
      id: videoIds.join(","),
    });

    const channelIds = [
      ...new Set(
        (videos.items || [])
          .map((v) => v.snippet?.channelId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const channelStats = new Map<string, number>();
    if (channelIds.length) {
      acquire(options.organisationId);
      type ChannelsResp = {
        items?: Array<{ id?: string; statistics?: { subscriberCount?: string } }>;
      };
      const channels = await ytGet<ChannelsResp>(YT_CHANNELS, {
        key: apiKey,
        part: "statistics",
        id: channelIds.slice(0, 50).join(","),
      });
      for (const ch of channels.items || []) {
        if (ch.id) channelStats.set(ch.id, Number(ch.statistics?.subscriberCount || 0));
      }
    }

    const results: SourceResult[] = [];
    for (const video of videos.items || []) {
      if (!video.id) continue;
      const url = `https://www.youtube.com/watch?v=${video.id}`;
      let commentPreview = "";
      try {
        acquire(options.organisationId);
        type CommentsResp = {
          items?: Array<{
            snippet?: {
              topLevelComment?: { snippet?: { textDisplay?: string; authorDisplayName?: string } };
            };
          }>;
        };
        const comments = await ytGet<CommentsResp>(YT_COMMENTS, {
          key: apiKey,
          part: "snippet",
          videoId: video.id,
          maxResults: "5",
          order: "relevance",
          textFormat: "plainText",
        });
        commentPreview = (comments.items || [])
          .map((c) => c.snippet?.topLevelComment?.snippet?.textDisplay || "")
          .filter(Boolean)
          .slice(0, 5)
          .join("\n---\n");
      } catch {
        // Comments disabled — keep video without them.
      }

      const views = Number(video.statistics?.viewCount || 0);
      const likes = Number(video.statistics?.likeCount || 0);
      const comments = Number(video.statistics?.commentCount || 0);
      const channelId = video.snippet?.channelId;
      const subscribers = channelId ? channelStats.get(channelId) : undefined;

      results.push({
        url,
        title: video.snippet?.title || url,
        content: [video.snippet?.description || "", commentPreview ? `Top comments:\n${commentPreview}` : ""]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 8000),
        author: video.snippet?.channelTitle || null,
        publishedAt: video.snippet?.publishedAt ? new Date(video.snippet.publishedAt) : null,
        platform: "youtube",
        engagement: {
          views,
          likes,
          comments,
          subscribers,
          score: views + likes * 10 + comments * 20,
        },
        rawMetadata: {
          videoId: video.id,
          channelId,
          statistics: video.statistics ?? {},
        },
      });
    }

    setCachedSourceResults(cacheKey, results);
    return results;
  },
};
