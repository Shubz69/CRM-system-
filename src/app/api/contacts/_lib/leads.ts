import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { markHumanLeadChange } from "@/services/lead-stage-guard";
import { HttpError } from "./http";

export type TargetStage = {
  pipelineId: string;
  stage: { id: string; name: string };
  /** True when the person picked the stage (so AI analysis won't move it later). */
  chosen: boolean;
};

/**
 * The stage new leads land in: a chosen stage of the workspace's default pipeline (the one
 * the board shows), or — like inbound leads — its "new" stage, falling back to the first
 * stage by position.
 */
export async function resolveTargetStage(
  organisationId: string,
  stageId?: string | null,
): Promise<TargetStage> {
  const pipeline = await prisma.pipeline.findFirst({
    where: { organisationId, isDefault: true },
    select: {
      id: true,
      stages: { orderBy: { position: "asc" }, select: { id: true, name: true, slug: true } },
    },
  });
  if (!pipeline) {
    throw new HttpError(409, "This workspace has no pipeline yet. Set one up on the Pipeline page first.");
  }
  if (stageId) {
    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (!stage) throw new HttpError(404, "That stage was not found in this workspace's pipeline.");
    return { pipelineId: pipeline.id, stage: { id: stage.id, name: stage.name }, chosen: true };
  }
  const first = pipeline.stages.find((s) => s.slug === "new") ?? pipeline.stages[0];
  if (!first) throw new HttpError(409, "The pipeline has no stages yet. Add a stage on the Pipeline page first.");
  return { pipelineId: pipeline.id, stage: { id: first.id, name: first.name }, chosen: false };
}

/**
 * Create one lead per contact that has no live lead yet, in the target stage, linked to the
 * contact's most recent conversation when there is one.
 *
 * Runs under a per-workspace transaction lock so two clicks (or a click and a bulk action)
 * can never give the same contact two leads. Callers must pass contact ids already checked
 * to be live contacts of `organisationId`.
 */
export async function createLeadsForContacts(input: {
  organisationId: string;
  contactIds: string[];
  target: TargetStage;
  userId: string;
}): Promise<{
  created: Array<{ id: string; contactId: string }>;
  alreadyInPipeline: string[];
}> {
  const contactIds = [...new Set(input.contactIds)];
  if (!contactIds.length) return { created: [], alreadyInPipeline: [] };
  const { organisationId, target, userId } = input;

  return prisma.$transaction(
    async (tx) => {
      // Transaction-scoped lock (safe with PgBouncer transaction pooling).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-leads:${organisationId}`}))`;

      const existing = await tx.lead.findMany({
        where: { organisationId, contactId: { in: contactIds }, deletedAt: null },
        select: { contactId: true },
      });
      const hasLead = new Set(existing.map((l) => l.contactId));
      const todo = contactIds.filter((id) => !hasLead.has(id));
      if (!todo.length) return { created: [], alreadyInPipeline: [...hasLead] };

      const conversations = await tx.conversation.findMany({
        where: { organisationId, contactId: { in: todo }, deletedAt: null },
        select: { id: true, contactId: true },
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      });
      const latestConversation = new Map<string, string>();
      for (const c of conversations) {
        if (!latestConversation.has(c.contactId)) latestConversation.set(c.contactId, c.id);
      }

      const baseMeta = { addedBy: "HUMAN", addedByUserId: userId, addedVia: "contacts" };
      const metadata = (
        target.chosen ? markHumanLeadChange(baseMeta, { stage: true, userId }) : baseMeta
      ) as Prisma.InputJsonValue;

      const created = await tx.lead.createManyAndReturn({
        data: todo.map((contactId) => ({
          organisationId,
          contactId,
          conversationId: latestConversation.get(contactId) ?? null,
          pipelineId: target.pipelineId,
          stageId: target.stage.id,
          metadata,
        })),
        select: { id: true, contactId: true },
      });
      return { created, alreadyInPipeline: [...hasLead] };
    },
    { timeout: 20_000 },
  );
}
