import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  estimateAgentRunStorage,
  getOrganisationAgentRetention,
  setOrganisationAgentRetention,
} from "@/services/agent-retention";
import { enqueueKnowledgeEmbeddingBackfill } from "@/jobs/maintenance";

export const dynamic = "force-dynamic";

const retentionBodySchema = z.object({
  toolCallPayloadDays: z.number().int().positive().optional(),
  stepFullDetailDays: z.number().int().positive().optional(),
  stepSkeletonAfterDays: z.number().int().positive().optional(),
  partialResultsFullDays: z.number().int().positive().optional(),
});

/**
 * Per-org agent storage estimate + retention windows.
 */
export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const [estimate, retention] = await Promise.all([
      estimateAgentRunStorage(session.organisationId),
      getOrganisationAgentRetention(session.organisationId),
    ]);
    return Response.json({ estimate, retention });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = retentionBodySchema.parse(await req.json());
    const retention = await setOrganisationAgentRetention({
      organisationId: session.organisationId,
      ...body,
    });
    return Response.json({ retention });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}

/** Kick an embedding backfill for the current org. */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "backfill-embeddings") {
      return jsonError('action must be "backfill-embeddings"', 400);
    }
    const result = await enqueueKnowledgeEmbeddingBackfill({
      organisationId: session.organisationId,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
