/**
 * Phase 15 — durable social publish dispatch.
 * Never marks PUBLISHED without provider acknowledgement (external id/url).
 * Never blind-retries UNKNOWN / RECONCILIATION_REQUIRED into CONFIRMED.
 */

import {
  ContentPieceStatus,
  MissionExternalOutcome,
  PublishingJobStatus,
  SocialConnectionStatus,
  SocialPlatform,
  type PublishingJob,
} from "@prisma/client";
import {
  getSocialProviderAdapter,
  type PublishContent,
  type PublishResult,
  type SocialProviderAdapter,
} from "@/adapters/social";
import { prisma } from "@/lib/db";
import { buildOrgScopedAssetContentUrl } from "@/services/asset-storage";
import { getConnectionAccessToken } from "@/services/social-connections";
import { getConnectorDefinition } from "@/services/connectors/catalogue";
import { appendDomainEvent } from "@/services/domain-events/append";
import { recordPublishResult } from "@/services/content-os";
import {
  connectorProviderKey,
  parseSocialPlatform,
  publishOperationName,
} from "@/services/publishing/platform";

const DISPATCHABLE: PublishingJobStatus[] = [
  PublishingJobStatus.APPROVED,
  PublishingJobStatus.QUEUED,
  PublishingJobStatus.SCHEDULED,
];

export type DispatchResult =
  | {
      ok: true;
      jobId: string;
      claimed: boolean;
      status: PublishingJobStatus;
      externalOutcome: MissionExternalOutcome;
      externalPostId?: string | null;
    }
  | {
      ok: false;
      jobId: string;
      claimed: boolean;
      reason: string;
      status: PublishingJobStatus;
      externalOutcome: MissionExternalOutcome;
    };

export type PublishingDispatchDeps = {
  getAdapter?: (platform: SocialPlatform) => SocialProviderAdapter;
  getAccessToken?: (socialConnectionId: string) => Promise<string | null>;
  publishOverride?: (
    platform: SocialPlatform,
    accessToken: string,
    externalAccountId: string,
    content: PublishContent,
  ) => Promise<PublishResult>;
  now?: () => Date;
};

/**
 * Claim + dispatch one PublishingJob. Idempotent for CONFIRMED / PUBLISHED.
 */
export async function dispatchPublishingJob(
  input: { organisationId: string; jobId: string; now?: Date },
  deps: PublishingDispatchDeps = {},
): Promise<DispatchResult> {
  const now = input.now ?? deps.now?.() ?? new Date();

  const existing = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
    include: {
      piece: { include: { variants: true } },
    },
  });
  if (!existing) {
    return {
      ok: false,
      jobId: input.jobId,
      claimed: false,
      reason: "not_found",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  if (
    existing.status === PublishingJobStatus.PUBLISHED ||
    existing.externalOutcome === MissionExternalOutcome.CONFIRMED
  ) {
    return {
      ok: true,
      jobId: existing.id,
      claimed: false,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      externalPostId: existing.externalPostId,
    };
  }

  if (existing.status === PublishingJobStatus.CANCELLED) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "cancelled",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  if (existing.status === PublishingJobStatus.RECONCILIATION_REQUIRED) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "needs_reconciliation",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  if (existing.status === PublishingJobStatus.DISPATCHING) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "already_dispatching",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  if (!DISPATCHABLE.includes(existing.status) && existing.status !== PublishingJobStatus.PUBLISHING) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "not_dispatchable",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  if (existing.scheduledAt && existing.scheduledAt > now) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "scheduled_future",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  if (existing.idempotencyKey) {
    const sibling = await prisma.publishingJob.findFirst({
      where: {
        organisationId: input.organisationId,
        idempotencyKey: existing.idempotencyKey,
        id: { not: existing.id },
        OR: [
          { externalOutcome: MissionExternalOutcome.CONFIRMED },
          { status: PublishingJobStatus.PUBLISHED },
        ],
      },
      select: { id: true },
    });
    if (sibling) {
      await prisma.publishingJob.updateMany({
        where: {
          id: existing.id,
          organisationId: input.organisationId,
          status: { in: DISPATCHABLE },
        },
        data: {
          status: PublishingJobStatus.CANCELLED,
          error: `Duplicate idempotencyKey already confirmed on job ${sibling.id}`,
          reconciliationNote: "Superseded by confirmed sibling — not dispatched",
        },
      });
      return {
        ok: false,
        jobId: existing.id,
        claimed: false,
        reason: "duplicate_idempotency_confirmed",
        status: PublishingJobStatus.CANCELLED,
        externalOutcome: existing.externalOutcome,
      };
    }
  }

  const claim = await prisma.publishingJob.updateMany({
    where: {
      id: existing.id,
      organisationId: input.organisationId,
      status: { in: DISPATCHABLE },
      externalOutcome: {
        in: [
          MissionExternalOutcome.NOT_STARTED,
          MissionExternalOutcome.PREPARED,
          MissionExternalOutcome.FAILED,
        ],
      },
      AND: [{ OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] }],
    },
    data: {
      status: PublishingJobStatus.DISPATCHING,
      externalOutcome: MissionExternalOutcome.DISPATCHING,
      attemptCount: { increment: 1 },
      lastDispatchAt: now,
      error: null,
    },
  });

  if (claim.count !== 1) {
    return {
      ok: false,
      jobId: existing.id,
      claimed: false,
      reason: "claim_lost",
      status: existing.status,
      externalOutcome: existing.externalOutcome,
    };
  }

  const job = existing;

  try {
    return await executeClaimed(job, deps, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown publish error";
    await markReconciliation(job.id, job.organisationId, `Exception during dispatch: ${message}`);
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "dispatch_exception",
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    };
  }
}

async function executeClaimed(
  job: PublishingJob & {
    piece: {
      id: string;
      title: string;
      body: string;
      status: ContentPieceStatus;
      assetId: string | null;
      variants: Array<{
        id: string;
        platform: string;
        body: string;
        metadata: unknown;
      }>;
    };
  },
  deps: PublishingDispatchDeps,
  now: Date,
): Promise<DispatchResult> {
  // Cancel race after claim (before provider call)
  const latest = await prisma.publishingJob.findFirst({
    where: { id: job.id, organisationId: job.organisationId },
  });
  if (!latest || latest.status === PublishingJobStatus.CANCELLED) {
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "cancelled",
      status: PublishingJobStatus.CANCELLED,
      externalOutcome: latest?.externalOutcome ?? job.externalOutcome,
    };
  }
  if (latest.externalOutcome === MissionExternalOutcome.CONFIRMED) {
    return {
      ok: true,
      jobId: job.id,
      claimed: false,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      externalPostId: latest.externalPostId,
    };
  }

  if (!job.socialConnectionId) {
    await markFailed(job.id, job.organisationId, "Missing socialConnectionId — cannot publish");
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "missing_connection",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  const {
    isZernioBackedConnection,
    resolvePublishTargetConnection,
    zernioAccountIdFromConnection,
  } = await import("@/services/publishing/publish-targets");

  const connection = await resolvePublishTargetConnection({
    organisationId: job.organisationId,
    socialConnectionId: job.socialConnectionId,
  });
  if (!connection) {
    await markFailed(
      job.id,
      job.organisationId,
      "Social connection not found for organisation",
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "wrong_organisation_or_missing_connection",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  if (connection.status !== SocialConnectionStatus.ACTIVE) {
    await markFailed(
      job.id,
      job.organisationId,
      `Social connection status is ${connection.status}`,
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "inactive_connection",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  // Canonical path: Zernio-connected Social Accounts (no native OAuth required).
  if (isZernioBackedConnection(connection)) {
    const accountId = zernioAccountIdFromConnection(connection);
    if (!accountId) {
      await markFailed(job.id, job.organisationId, "Connected account id missing for publish target");
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "missing_connection",
        status: PublishingJobStatus.FAILED,
        externalOutcome: MissionExternalOutcome.FAILED,
      };
    }

    // Caption-only is allowed for Zernio; media is optional.
    const zernioContent = await buildZernioPublishContent(job);
    if (!zernioContent.ok) {
      await markFailed(job.id, job.organisationId, zernioContent.error);
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "missing_media",
        status: PublishingJobStatus.FAILED,
        externalOutcome: MissionExternalOutcome.FAILED,
      };
    }

    const { publishViaZernio } = await import("@/adapters/zernio");
    const { writeAuditLog } = await import("@/services/audit");
    const timeoutMs = 60_000;
    const raced = await racePublish(async () => {
      const result = await publishViaZernio({
        organisationId: job.organisationId,
        content: zernioContent.caption,
        accountIds: [accountId],
        mediaUrls: zernioContent.mediaUrl ? [zernioContent.mediaUrl] : undefined,
        scheduledAt: job.scheduledAt?.toISOString(),
      });
      if (!result.ok) {
        return { ok: false as const, error: result.error || "Publish failed" };
      }
      return { ok: true as const, externalPostId: result.id || undefined };
    }, timeoutMs);

    if (raced.kind === "timeout") {
      await markReconciliation(
        job.id,
        job.organisationId,
        `Provider publish timed out after ${timeoutMs}ms — outcome unknown; do not blind-retry to CONFIRMED`,
      );
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "provider_timeout",
        status: PublishingJobStatus.RECONCILIATION_REQUIRED,
        externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      };
    }
    if (raced.kind === "unknown") {
      await markReconciliation(job.id, job.organisationId, raced.message);
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "provider_unknown",
        status: PublishingJobStatus.RECONCILIATION_REQUIRED,
        externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      };
    }
    const publishResult = raced.result;
    if (!publishResult.ok) {
      const err = publishResult.error || "Provider rejected publish";
      await markFailed(job.id, job.organisationId, err);
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "provider_rejected",
        status: PublishingJobStatus.FAILED,
        externalOutcome: MissionExternalOutcome.FAILED,
      };
    }
    if (!publishResult.externalPostId) {
      await markReconciliation(
        job.id,
        job.organisationId,
        "Provider returned success without external post id — reconciliation required",
      );
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: "missing_external_id",
        status: PublishingJobStatus.RECONCILIATION_REQUIRED,
        externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      };
    }
    await recordPublishResult({
      organisationId: job.organisationId,
      jobId: job.id,
      externalPostId: publishResult.externalPostId,
      externalUrl: null,
    });
    await writeAuditLog({
      organisationId: job.organisationId,
      action: "content.publish.confirmed",
      entityType: "PublishingJob",
      entityId: job.id,
      metadata: {
        socialConnectionId: connection.id,
        provider: "ZERNIO",
        externalPostId: publishResult.externalPostId,
        platform: job.platform,
      },
    });
    return {
      ok: true,
      jobId: job.id,
      claimed: true,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      externalPostId: publishResult.externalPostId,
    };
  }

  if (connection.expiresAt && connection.expiresAt < now) {
    await markFailed(job.id, job.organisationId, "OAuth credentials expired");
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "expired_credentials",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  const contentBuilt = await buildPublishContent(job);
  if (!contentBuilt.ok) {
    await markFailed(job.id, job.organisationId, contentBuilt.error);
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "missing_media",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  const platform = parseSocialPlatform(job.platform) ?? connection.platform;
  const getAdapter = deps.getAdapter ?? getSocialProviderAdapter;
  const adapter = getAdapter(platform);
  if (!adapter.isConfigured()) {
    await markFailed(
      job.id,
      job.organisationId,
      `${platform} app credentials are not configured`,
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "provider_not_configured",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }
  if (!adapter.capabilities.publish || (!adapter.publish && !deps.publishOverride)) {
    await markFailed(job.id, job.organisationId, `${platform} adapter has no publish()`);
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "publish_not_supported",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  const getToken = deps.getAccessToken ?? getConnectionAccessToken;
  const accessToken = await getToken(connection.id);
  if (!accessToken) {
    await markFailed(job.id, job.organisationId, "No access token for social connection");
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "missing_token",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  const timeoutMs = resolvePublishTimeoutMs(platform);
  const publishFn =
    deps.publishOverride ??
    ((p, token, accountId, body) => getAdapter(p).publish!(token, accountId, body));

  const raced = await racePublish(
    () => publishFn(platform, accessToken, connection.externalAccountId, contentBuilt.content),
    timeoutMs,
  );

  if (raced.kind === "timeout") {
    await markReconciliation(
      job.id,
      job.organisationId,
      `Provider publish timed out after ${timeoutMs}ms — outcome unknown; do not blind-retry to CONFIRMED`,
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "provider_timeout",
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    };
  }

  if (raced.kind === "unknown") {
    await markReconciliation(job.id, job.organisationId, raced.message);
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "provider_unknown",
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    };
  }

  const publishResult = raced.result;
  if (!publishResult.ok) {
    const err = publishResult.error || "Provider rejected publish";
    if (/429|rate.?limit/i.test(err) || /timeout|ETIMEDOUT|ECONNRESET|503|502/i.test(err)) {
      await markReconciliation(
        job.id,
        job.organisationId,
        `Unknown outcome after provider error: ${err}`,
      );
      return {
        ok: false,
        jobId: job.id,
        claimed: true,
        reason: /429/.test(err) ? "provider_429" : "provider_timeout_or_5xx",
        status: PublishingJobStatus.RECONCILIATION_REQUIRED,
        externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      };
    }
    await markFailed(job.id, job.organisationId, err);
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "provider_rejected",
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
    };
  }

  if (!publishResult.externalPostId?.trim()) {
    await markReconciliation(
      job.id,
      job.organisationId,
      "Provider returned ok without externalPostId — reconciliation required",
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "missing_external_id",
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    };
  }

  const beforeConfirm = await prisma.publishingJob.findFirst({
    where: { id: job.id, organisationId: job.organisationId },
  });
  if (!beforeConfirm || beforeConfirm.status === PublishingJobStatus.CANCELLED) {
    await markReconciliation(
      job.id,
      job.organisationId,
      `Job cancelled after provider returned id ${publishResult.externalPostId} — verify on platform`,
    );
    return {
      ok: false,
      jobId: job.id,
      claimed: true,
      reason: "cancelled_after_provider",
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    };
  }
  if (beforeConfirm.externalOutcome === MissionExternalOutcome.CONFIRMED) {
    return {
      ok: true,
      jobId: job.id,
      claimed: false,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      externalPostId: beforeConfirm.externalPostId,
    };
  }

  await recordPublishResult({
    organisationId: job.organisationId,
    jobId: job.id,
    externalPostId: publishResult.externalPostId,
    externalUrl: null,
  });

  return {
    ok: true,
    jobId: job.id,
    claimed: true,
    status: PublishingJobStatus.PUBLISHED,
    externalOutcome: MissionExternalOutcome.CONFIRMED,
    externalPostId: publishResult.externalPostId,
  };
}

function resolvePublishTimeoutMs(platform: SocialPlatform): number {
  const def = getConnectorDefinition(connectorProviderKey(platform));
  const op = def?.operations.find((o) => o.name === publishOperationName(platform));
  return op?.timeoutMs ?? 120_000;
}

type RaceOutcome =
  | { kind: "result"; result: PublishResult }
  | { kind: "timeout" }
  | { kind: "unknown"; message: string };

async function racePublish(
  run: () => Promise<PublishResult>,
  timeoutMs: number,
): Promise<RaceOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run().then((r) => ({ kind: "result" as const, result: r })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted|network|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)) {
      return { kind: "unknown", message: `Ambiguous provider error: ${message}` };
    }
    return { kind: "unknown", message: `Provider call threw: ${message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildZernioPublishContent(job: {
  organisationId: string;
  pieceId: string;
  platform: string;
  variantId: string | null;
  piece: {
    body: string;
    title: string;
    assetId: string | null;
    variants: Array<{
      id: string;
      platform: string;
      body: string;
      metadata: unknown;
    }>;
  };
}): Promise<{ ok: true; caption: string; mediaUrl?: string } | { ok: false; error: string }> {
  const built = await buildPublishContent(job);
  if (built.ok) {
    return { ok: true, caption: built.content.caption || "", mediaUrl: built.content.mediaUrl };
  }
  // Fall back to caption-only when media is missing (Zernio text posts).
  const variant = job.variantId
    ? job.piece.variants.find((v) => v.id === job.variantId)
    : job.piece.variants.find(
        (v) => v.platform.toLowerCase() === job.platform.toLowerCase(),
      ) || job.piece.variants[0];
  const caption =
    variant?.body?.trim() || job.piece.body?.trim() || job.piece.title?.trim() || "";
  if (!caption) {
    return { ok: false, error: "Publish requires caption text" };
  }
  return { ok: true, caption };
}

async function buildPublishContent(job: {
  organisationId: string;
  pieceId: string;
  platform: string;
  variantId: string | null;
  piece: {
    body: string;
    title: string;
    assetId: string | null;
    variants: Array<{
      id: string;
      platform: string;
      body: string;
      metadata: unknown;
    }>;
  };
}): Promise<{ ok: true; content: PublishContent } | { ok: false; error: string }> {
  const variant = job.variantId
    ? job.piece.variants.find((v) => v.id === job.variantId)
    : job.piece.variants.find(
        (v) => v.platform.toLowerCase() === job.platform.toLowerCase(),
      ) || job.piece.variants[0];

  const caption =
    variant?.body?.trim() || job.piece.body?.trim() || job.piece.title?.trim() || "";
  const meta = (variant?.metadata ?? {}) as Record<string, unknown>;
  let mediaUrl =
    (typeof meta.mediaUrl === "string" && meta.mediaUrl.startsWith("http") && meta.mediaUrl) ||
    (typeof meta.publicMediaUrl === "string" &&
      meta.publicMediaUrl.startsWith("http") &&
      meta.publicMediaUrl) ||
    "";
  let mediaType: "IMAGE" | "VIDEO" = meta.mediaType === "VIDEO" ? "VIDEO" : "IMAGE";

  if (!mediaUrl && job.piece.assetId) {
    const asset = await prisma.asset.findFirst({
      where: { id: job.piece.assetId, organisationId: job.organisationId },
      select: { id: true, mimeType: true },
    });
    if (asset) {
      const signed = buildOrgScopedAssetContentUrl({
        organisationId: job.organisationId,
        assetId: asset.id,
        expiresInSeconds: 60 * 60,
        absolute: true,
      });
      if (!signed.url.startsWith("http")) {
        return {
          ok: false,
          error:
            "Cannot build absolute media URL (set APP_URL) — providers require a publicly reachable mediaUrl",
        };
      }
      mediaUrl = signed.url;
      if (asset.mimeType.startsWith("video/")) mediaType = "VIDEO";
    }
  }

  if (!mediaUrl) {
    return {
      ok: false,
      error: "Publish requires a public mediaUrl on variant.metadata or piece.assetId",
    };
  }

  return { ok: true, content: { caption, mediaUrl, mediaType } };
}

async function markFailed(jobId: string, organisationId: string, error: string) {
  await prisma.$transaction(async (tx) => {
    await tx.publishingJob.updateMany({
      where: {
        id: jobId,
        organisationId,
        externalOutcome: { not: MissionExternalOutcome.CONFIRMED },
      },
      data: {
        status: PublishingJobStatus.FAILED,
        externalOutcome: MissionExternalOutcome.FAILED,
        error,
      },
    });
    const job = await tx.publishingJob.findFirst({ where: { id: jobId, organisationId } });
    if (job) {
      await tx.contentPiece.updateMany({
        where: { id: job.pieceId, organisationId },
        data: { status: ContentPieceStatus.FAILED },
      });
      await appendDomainEvent(tx, {
        organisationId,
        eventType: "CONTENT_PUBLISH_FAILED",
        aggregateType: "PublishingJob",
        aggregateId: jobId,
        payload: {
          publishingJobId: jobId,
          errorSummary: error.slice(0, 500),
        },
        dedupeKey: `CONTENT_PUBLISH_FAILED:${jobId}:${job.attemptCount}`,
      });
    }
  });
}

async function markReconciliation(jobId: string, organisationId: string, note: string) {
  await prisma.$transaction(async (tx) => {
    await tx.publishingJob.updateMany({
      where: {
        id: jobId,
        organisationId,
        externalOutcome: { not: MissionExternalOutcome.CONFIRMED },
      },
      data: {
        status: PublishingJobStatus.RECONCILIATION_REQUIRED,
        externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
        reconciliationNote: note.slice(0, 4000),
        error: note.slice(0, 4000),
      },
    });
    await appendDomainEvent(tx, {
      organisationId,
      eventType: "CONTENT_PUBLISH_RECONCILIATION_REQUIRED",
      aggregateType: "PublishingJob",
      aggregateId: jobId,
      payload: {
        publishingJobId: jobId,
        reason: note.slice(0, 500),
      },
      dedupeKey: `CONTENT_PUBLISH_RECONCILIATION_REQUIRED:${jobId}:${Date.now()}`,
    });
  });
}
