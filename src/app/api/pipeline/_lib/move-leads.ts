import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { markHumanLeadChange } from "@/services/lead-stage-guard";

/**
 * Move leads to `stageId` and mark the move as a person's decision (inbound AI analysis
 * won't move them again).
 *
 * The rows are locked and their metadata re-read inside the transaction, so only the
 * stageChangedBy* keys change: the AI writes other keys (crmMemory, lastAiScore…) in its own
 * transactions, and writing back a copy read earlier would erase them. Callers pass lead ids
 * already checked to be live leads of `organisationId`. Returns how many leads were moved.
 */
export async function moveLeadsMarkedHuman(input: {
  organisationId: string;
  leadIds: string[];
  stageId: string;
  userId: string;
  now?: Date;
}): Promise<number> {
  const { organisationId, stageId, userId } = input;
  const leadIds = [...new Set(input.leadIds)];
  if (!leadIds.length) return 0;
  const now = input.now ?? new Date();

  return prisma.$transaction(
    async (tx) => {
      // Fixed lock order (by id) so two overlapping bulk moves can't deadlock.
      await tx.$queryRaw`
        SELECT "id" FROM "Lead"
        WHERE "id" = ANY(${leadIds}::text[]) AND "organisationId" = ${organisationId}
        ORDER BY "id"
        FOR UPDATE
      `;
      const fresh = await tx.lead.findMany({
        where: { id: { in: leadIds }, organisationId, deletedAt: null },
        select: { id: true, metadata: true },
      });
      // Sequential on purpose: one interactive transaction = one connection.
      for (const lead of fresh) {
        await tx.lead.updateMany({
          where: { id: lead.id, organisationId },
          data: {
            stageId,
            metadata: markHumanLeadChange(lead.metadata, { stage: true, userId }, now) as Prisma.InputJsonValue,
          },
        });
      }
      return fresh.length;
    },
    { timeout: 30_000 },
  );
}
