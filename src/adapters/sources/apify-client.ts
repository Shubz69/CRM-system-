import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { SourcePlatform } from "@/adapters/sources/types";

const APIFY_API = "https://api.apify.com/v2";

export type ApifyHardRunOptions = {
  /** Cap dataset items requested / returned. */
  maxItems: number;
  /** Hard USD charge cap for PPE actors (Apify enforces when supported). */
  maxTotalChargeUsd?: number;
  /** Actor memory in MB. */
  memory?: number;
  /** Actor wall timeout in seconds (Apify API). */
  timeoutSecs?: number;
  /** Build tag or number pin. */
  build?: string;
};

export type ApifyRunResult = {
  runId: string;
  datasetId: string | null;
  status: string;
  items: Record<string, unknown>[];
  /** Authoritative completed-run usage when Apify reports it. */
  usageTotalUsd: number | null;
  build?: string | null;
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
    buildNumber?: string | number | null;
    actId?: string | null;
  };
};

/** Build Apify run start query string with hard safety options. */
export function buildApifyRunQuery(options: ApifyHardRunOptions): string {
  const params = new URLSearchParams();
  params.set("waitForFinish", "0");
  if (Number.isFinite(options.maxItems) && options.maxItems > 0) {
    params.set("maxItems", String(Math.floor(options.maxItems)));
  }
  if (
    options.maxTotalChargeUsd != null &&
    Number.isFinite(options.maxTotalChargeUsd) &&
    options.maxTotalChargeUsd > 0
  ) {
    params.set("maxTotalChargeUsd", String(options.maxTotalChargeUsd));
  }
  if (options.memory != null && Number.isFinite(options.memory) && options.memory > 0) {
    params.set("memory", String(Math.floor(options.memory)));
  }
  if (
    options.timeoutSecs != null &&
    Number.isFinite(options.timeoutSecs) &&
    options.timeoutSecs > 0
  ) {
    params.set("timeout", String(Math.floor(options.timeoutSecs)));
  }
  if (options.build && options.build.trim()) {
    params.set("build", options.build.trim());
  }
  return params.toString();
}

/**
 * Start an Apify actor, poll until terminal status or timeout, then load dataset items.
 * Never scrapes platforms directly — all traffic goes through Apify.
 * Hard options (maxItems, maxTotalChargeUsd, memory, timeout, build) are applied
 * at the API level where supported. Completed-run usageTotalUsd is authoritative for spend.
 */
export async function runApifyActor(input: {
  platform: SourcePlatform;
  actorId: string;
  actorInput: Record<string, unknown>;
  timeoutMs: number;
  maxItems: number;
  maxTotalChargeUsd?: number;
  memoryMb?: number;
  build?: string;
}): Promise<ApifyRunResult> {
  const actorPath = toApifyActorPath(input.actorId);
  const started = Date.now();
  const deadline = started + input.timeoutMs;
  const timeoutSecs = Math.max(5, Math.ceil(input.timeoutMs / 1000));

  const query = buildApifyRunQuery({
    maxItems: input.maxItems,
    maxTotalChargeUsd: input.maxTotalChargeUsd,
    memory: input.memoryMb,
    timeoutSecs,
    build: input.build,
  });

  const startRes = await apifyFetch(`/acts/${actorPath}/runs?${query}`, {
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
  let build =
    startJson.data?.buildNumber != null ? String(startJson.data.buildNumber) : input.build ?? null;

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
    if (pollJson.data?.buildNumber != null) {
      build = String(pollJson.data.buildNumber);
    }
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
    return { runId, datasetId: null, status, items: [], usageTotalUsd, build };
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
    build,
  };
}
