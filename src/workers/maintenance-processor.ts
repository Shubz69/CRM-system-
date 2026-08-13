import type { Job } from "bullmq";
import { backfillKnowledgeEmbeddings } from "@/services/knowledge";
import {
  pruneAgentArtifactsAllOrganisations,
  pruneAgentArtifactsForOrganisation,
} from "@/services/agent-retention";
import { enqueueKnowledgeEmbeddingBackfill } from "@/jobs/maintenance";
import { logger } from "@/lib/logger";

/**
 * Processes maintenance queue jobs (retention + embedding backfill).
 * Mutating work is always organisation-scoped.
 */
export async function processMaintenanceJob(job: Job): Promise<unknown> {
  const name = job.name;
  const organisationId =
    typeof job.data?.organisationId === "string" ? job.data.organisationId : null;

  if (name === "agent-retention-sweep") {
    if (organisationId) {
      return pruneAgentArtifactsForOrganisation(organisationId);
    }
    return pruneAgentArtifactsAllOrganisations();
  }

  if (name === "knowledge-embedding-backfill") {
    if (!organisationId) {
      throw new Error("knowledge-embedding-backfill requires organisationId");
    }
    const cursor =
      typeof job.data?.cursor === "string"
        ? job.data.cursor
        : job.data?.cursor === null
          ? null
          : undefined;
    const batchSize =
      typeof job.data?.batchSize === "number" ? job.data.batchSize : undefined;

    const result = await backfillKnowledgeEmbeddings({
      organisationId,
      cursor,
      batchSize,
    });

    if (!result.skippedUnconfigured && result.remaining > 0 && result.cursor) {
      await enqueueKnowledgeEmbeddingBackfill({
        organisationId,
        cursor: result.cursor,
        batchSize,
      });
      logger.info("Re-enqueued embedding backfill continuation", {
        organisationId,
        remaining: result.remaining,
        cursor: result.cursor,
      });
    }

    return result;
  }

  throw new Error(`Unknown maintenance job name: ${name}`);
}
