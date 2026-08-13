import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { SourcePlatform } from "@/adapters/sources/types";

const APIFY_API = "https://api.apify.com/v2";

export type ApifyRunResult = {
  runId: string;
  datasetId: string | null;
  status: string;
  items: Record<string, unknown>[];
  usageTotalUsd: number | null;
};

export class ApifyTimeoutError extends Error {
  readonly code = "APIFY_TIMEOUT";
  constructor(
    readonly platform: SourcePlatform,
    message: string,
  ) {
    super(message);
    this.name = "ApifyTimeoutError";
  }
}

export class ApifyRunFailedError extends Error {
  readonly code = "APIFY_RUN_FAILED";
  constructor(
    readonly platform: SourcePlatform,
    message: string,
    readonly apifyStatus?: string,
  ) {
    super(message);
    this.name = "ApifyRunFailedError";
  }
}

/** Actor id for URL path: `owner/name` → `owner~name`. */
export function toApifyActorPath(actorId: string): string {
  return actorId.trim().replace("/", "~");
}

function requireToken(): string {
  const token = getEnv().APIFY_TOKEN;
  if (!token) {
    throw new Error("APIFY_TOKEN is not configured");
  }
  return token;
}

async function apifyFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const token = requireToken();
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${APIFY_API}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(rest.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function abortRun(runId: string): Promise<void> {
  try {
    await apifyFetch(`/actor-runs/${runId}/abort`, { method: "POST", timeoutMs: 15_000 });
  } catch (error) {
    logger.warn("Failed to abort Apify run", {
      runId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

type RunPayload = {
  data?: {
    id?: string;
    status?: string;
    defaultDatasetId?: string | null;
    usageTotalUsd?: number | null;
  };
};

/**
 * Start an Apify actor, poll until terminal status or timeout, then load dataset items.
 * Never scrapes platforms directly — all traffic goes through Apify.
 */
export async function runApifyActor(input: {
  platform: SourcePlatform;
  actorId: string;
  actorInput: Record<string, unknown>;
  timeoutMs: number;
  maxItems: number;
}): Promise<ApifyRunResult> {
  const actorPath = toApifyActorPath(input.actorId);
  const started = Date.now();
  const deadline = started + input.timeoutMs;

  const startRes = await apifyFetch(`/acts/${actorPath}/runs?waitForFinish=0`, {
    method: "POST",
    body: JSON.stringify(input.actorInput),
    timeoutMs: 30_000,
  });

  if (!startRes.ok) {
    const body = await startRes.text();
    logger.error("Apify actor start failed", {
      platform: input.platform,
      actorId: input.actorId,
      status: startRes.status,
      body: body.slice(0, 500),
    });
    throw new ApifyRunFailedError(
      input.platform,
      `Apify start failed (${startRes.status})`,
      String(startRes.status),
    );
  }

  const startJson = (await startRes.json()) as RunPayload;
  const runId = startJson.data?.id;
  if (!runId) {
    throw new ApifyRunFailedError(input.platform, "Apify start response missing run id");
  }

  let status = startJson.data?.status || "RUNNING";
  let datasetId = startJson.data?.defaultDatasetId ?? null;
  let usageTotalUsd = startJson.data?.usageTotalUsd ?? null;

  const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

  while (!terminal.has(status)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.warn("Apify actor timed out — aborting run", {
        platform: input.platform,
        actorId: input.actorId,
        runId,
        timeoutMs: input.timeoutMs,
      });
      await abortRun(runId);
      throw new ApifyTimeoutError(
        input.platform,
        `Apify run timed out after ${input.timeoutMs}ms`,
      );
    }

    // Poll every 2s; waitForFinish capped at 60s by Apify API.
    const waitSec = Math.min(60, Math.max(1, Math.floor(remaining / 1000)));
    await new Promise((r) => setTimeout(r, Math.min(2000, remaining)));

    const pollRes = await apifyFetch(
      `/actor-runs/${runId}?waitForFinish=${Math.min(waitSec, 5)}`,
      { timeoutMs: Math.min(remaining, 20_000) },
    );
    if (!pollRes.ok) {
      const body = await pollRes.text();
      logger.error("Apify run poll failed", {
        platform: input.platform,
        runId,
        status: pollRes.status,
        body: body.slice(0, 400),
      });
      throw new ApifyRunFailedError(
        input.platform,
        `Apify poll failed (${pollRes.status})`,
        String(pollRes.status),
      );
    }
    const pollJson = (await pollRes.json()) as RunPayload;
    status = pollJson.data?.status || status;
    datasetId = pollJson.data?.defaultDatasetId ?? datasetId;
    usageTotalUsd = pollJson.data?.usageTotalUsd ?? usageTotalUsd;
  }

  if (status !== "SUCCEEDED") {
    logger.warn("Apify actor finished without success", {
      platform: input.platform,
      actorId: input.actorId,
      runId,
      status,
      durationMs: Date.now() - started,
    });
    throw new ApifyRunFailedError(
      input.platform,
      `Apify run ended with status ${status}`,
      status,
    );
  }

  if (!datasetId) {
    return { runId, datasetId: null, status, items: [], usageTotalUsd };
  }

  const itemsRes = await apifyFetch(
    `/datasets/${datasetId}/items?clean=1&format=json&limit=${Math.max(1, input.maxItems)}`,
    { timeoutMs: 30_000 },
  );
  if (!itemsRes.ok) {
    const body = await itemsRes.text();
    logger.error("Apify dataset fetch failed", {
      platform: input.platform,
      runId,
      datasetId,
      status: itemsRes.status,
      body: body.slice(0, 400),
    });
    throw new ApifyRunFailedError(
      input.platform,
      `Apify dataset fetch failed (${itemsRes.status})`,
      String(itemsRes.status),
    );
  }

  const items = (await itemsRes.json()) as unknown;
  const list = Array.isArray(items) ? (items as Record<string, unknown>[]) : [];

  return {
    runId,
    datasetId,
    status,
    items: list.slice(0, input.maxItems),
    usageTotalUsd,
  };
}
