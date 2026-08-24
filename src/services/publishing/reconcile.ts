/**
 * Phase 15 — reconcile UNKNOWN / RECONCILIATION_REQUIRED publish outcomes.
 * Never blind-retries to CONFIRMED. Surfaces provider lookup limitations honestly.
 */

import { MissionExternalOutcome, PublishingJobStatus, SocialPlatform } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getConnectionAccessToken } from "@/services/social-connections";
import { getReconciliationPlan } from "@/services/connectors/reconciliation";
import { recordPublishResult } from "@/services/content-os";
import {
  connectorProviderKey,
  parseSocialPlatform,
  publishOperationName,
} from "@/services/publishing/platform";

export type ReconcileResult = {
  jobId: string;
  status: PublishingJobStatus;
  externalOutcome: MissionExternalOutcome;
  note: string;
  providerLookupSupported: boolean;
  resolved: boolean;
};

export async function reconcilePublishingJob(input: {
  organisationId: string;
  jobId: string;
  /** Optional manual confirmation when operator verified externally. */
  manualExternalPostId?: string | null;
  manualExternalUrl?: string | null;
}): Promise<ReconcileResult> {
  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
  });
  if (!job) throw new Error("Publishing job not found");

  if (
    job.status === PublishingJobStatus.PUBLISHED &&
    job.externalOutcome === MissionExternalOutcome.CONFIRMED
  ) {
    return {
      jobId: job.id,
      status: job.status,
      externalOutcome: job.externalOutcome,
      note: "Already confirmed — no replay",
      providerLookupSupported: false,
      resolved: true,
    };
  }

  if (input.manualExternalPostId?.trim() || input.manualExternalUrl?.trim()) {
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      externalPostId: input.manualExternalPostId ?? null,
      externalUrl: input.manualExternalUrl ?? null,
    });
    return {
      jobId: job.id,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      note: "Confirmed via operator-provided provider acknowledgement",
      providerLookupSupported: false,
      resolved: true,
    };
  }

  const platform = parseSocialPlatform(job.platform);
  if (!platform) {
    const note = `Unknown platform “${job.platform}” — no provider lookup. Do not blind-retry to CONFIRMED.`;
    await stampNote(job.id, input.organisationId, note);
    return {
      jobId: job.id,
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      note,
      providerLookupSupported: false,
      resolved: false,
    };
  }

  const plan = getReconciliationPlan(
    connectorProviderKey(platform),
    publishOperationName(platform),
  );

  if (!job.externalPostId?.trim()) {
    const note =
      `${platform} catalogue support=${plan?.support ?? "unknown"}, but this job has no externalPostId ` +
      `(timeout/unknown before provider returned an id). Adapter has no status-poll without an id — ` +
      `operator must verify on the platform. Do not blind-retry to CONFIRMED.`;
    await stampNote(job.id, input.organisationId, note);
    return {
      jobId: job.id,
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      note,
      providerLookupSupported: plan?.support === "lookup",
      resolved: false,
    };
  }

  if (!job.socialConnectionId) {
    const note = "Missing social connection — cannot look up provider object.";
    await stampNote(job.id, input.organisationId, note);
    return {
      jobId: job.id,
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      note,
      providerLookupSupported: false,
      resolved: false,
    };
  }

  const accessToken = await getConnectionAccessToken(job.socialConnectionId);
  if (!accessToken) {
    const note = "No access token — cannot look up provider object.";
    await stampNote(job.id, input.organisationId, note);
    return {
      jobId: job.id,
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      note,
      providerLookupSupported: false,
      resolved: false,
    };
  }

  const lookedUp = await lookupExternalPost({
    platform,
    accessToken,
    externalPostId: job.externalPostId,
  });

  if (lookedUp.exists === true) {
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      externalPostId: lookedUp.externalPostId ?? job.externalPostId,
      externalUrl: lookedUp.externalUrl ?? null,
    });
    return {
      jobId: job.id,
      status: PublishingJobStatus.PUBLISHED,
      externalOutcome: MissionExternalOutcome.CONFIRMED,
      note: lookedUp.note,
      providerLookupSupported: true,
      resolved: true,
    };
  }

  if (lookedUp.exists === false) {
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      error: lookedUp.note,
    });
    return {
      jobId: job.id,
      status: PublishingJobStatus.FAILED,
      externalOutcome: MissionExternalOutcome.FAILED,
      note: lookedUp.note,
      providerLookupSupported: true,
      resolved: true,
    };
  }

  await stampNote(job.id, input.organisationId, lookedUp.note);
  return {
    jobId: job.id,
    status: PublishingJobStatus.RECONCILIATION_REQUIRED,
    externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
    note: lookedUp.note,
    providerLookupSupported: lookedUp.supported,
    resolved: false,
  };
}

async function stampNote(jobId: string, organisationId: string, note: string) {
  await prisma.publishingJob.updateMany({
    where: { id: jobId, organisationId },
    data: {
      status: PublishingJobStatus.RECONCILIATION_REQUIRED,
      externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
      reconciliationNote: note.slice(0, 4000),
    },
  });
}

type LookupResult = {
  exists: boolean | null;
  supported: boolean;
  externalPostId?: string;
  externalUrl?: string;
  note: string;
};

async function lookupExternalPost(input: {
  platform: SocialPlatform;
  accessToken: string;
  externalPostId: string;
}): Promise<LookupResult> {
  if (input.platform === SocialPlatform.INSTAGRAM) {
    const version = getEnv().INSTAGRAM_GRAPH_API_VERSION || "v21.0";
    try {
      const res = await fetch(
        `https://graph.instagram.com/${version}/${encodeURIComponent(input.externalPostId)}` +
          `?fields=id,permalink&access_token=${encodeURIComponent(input.accessToken)}`,
      );
      const json = (await res.json().catch(() => null)) as {
        id?: string;
        permalink?: string;
        error?: { message?: string; code?: number };
      } | null;
      if (res.ok && json?.id) {
        return {
          exists: true,
          supported: true,
          externalPostId: json.id,
          externalUrl: json.permalink,
          note: "Instagram Graph lookup confirmed media exists",
        };
      }
      if (json?.error?.code === 100 || res.status === 404) {
        return {
          exists: false,
          supported: true,
          note: json?.error?.message || "Instagram media not found",
        };
      }
      return {
        exists: null,
        supported: true,
        note: `Instagram lookup inconclusive: ${json?.error?.message || `HTTP ${res.status}`}`,
      };
    } catch (err) {
      return {
        exists: null,
        supported: true,
        note: `Instagram lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (input.platform === SocialPlatform.TIKTOK) {
    try {
      const res = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: input.externalPostId }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { status?: string };
        error?: { message?: string };
      } | null;
      const status = json?.data?.status?.toUpperCase();
      if (status === "PUBLISH_COMPLETE" || status === "PUBLISHED") {
        return {
          exists: true,
          supported: true,
          externalPostId: input.externalPostId,
          note: `TikTok status fetch: ${status}`,
        };
      }
      if (status === "FAILED") {
        return {
          exists: false,
          supported: true,
          note: `TikTok status fetch: ${status}`,
        };
      }
      return {
        exists: null,
        supported: true,
        note:
          json?.error?.message ||
          `TikTok status fetch inconclusive (status=${status ?? "unknown"}). Do not blind-retry to CONFIRMED.`,
      };
    } catch (err) {
      return {
        exists: null,
        supported: true,
        note: `TikTok lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    exists: null,
    supported: false,
    note:
      "LinkedIn catalogue lists lookup, but no post-lookup is implemented in the adapter. " +
      "Operator must verify on LinkedIn. Do not blind-retry to CONFIRMED.",
  };
}
