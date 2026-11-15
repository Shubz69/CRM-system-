import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, requirePermissionForMutation, jsonError } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { brokenFunnelPair, FUNNEL_STAGE_SLUGS } from "@/lib/pipeline-funnel";
import { readJsonObject, RouteError, routeErrorResponse } from "../_lib/http";
import {
  applyPositions,
  assertNameFree,
  defaultInsertPosition,
  listStages,
  lockPipeline,
  MAX_STAGES,
  requireDefaultPipelineId,
  stageColorSchema,
  stageNameSchema,
  toStageDto,
  uniqueStageSlug,
} from "../_lib/stages";

/**
 * Stages of the workspace's default pipeline — no leads, no contacts.
 * For screens that only need the stage list (inbox stage picker, CRM hub);
 * the pipeline board keeps using GET /api/pipeline.
 */
export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const pipeline = await prisma.pipeline.findFirst({
      where: { organisationId: session.organisationId, isDefault: true },
      select: {
        id: true,
        stages: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            name: true,
            slug: true,
            position: true,
            color: true,
            isWon: true,
            isLost: true,
          },
        },
      },
    });

    return Response.json({ pipelineId: pipeline?.id ?? null, stages: pipeline?.stages ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z
  .object({
    name: stageNameSchema,
    color: stageColorSchema.optional(),
    isWon: z.boolean().optional(),
    isLost: z.boolean().optional(),
    /** 0-based slot; defaults to just before the closing won/lost stages. */
    position: z.number().int("Position must be a whole number").min(0, "Position can't be negative").optional(),
  })
  .refine((b) => !(b.isWon && b.isLost), { message: "A stage can't be both won and lost" });

/** Add a custom stage to the default pipeline. */
export async function POST(req: NextRequest) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("pipeline:manage", req, raw);
    const body = createSchema.parse(raw);
    const pipelineId = await requireDefaultPipelineId(session.organisationId);

    const result = await prisma.$transaction(async (tx) => {
      await lockPipeline(tx, pipelineId);
      const stages = await listStages(tx, pipelineId);
      if (stages.length >= MAX_STAGES) {
        throw new RouteError(409, `A pipeline can have at most ${MAX_STAGES} stages.`);
      }
      assertNameFree(stages, body.name);
      const slug = uniqueStageSlug(body.name, stages.map((s) => s.slug));
      const insertAt = Math.min(body.position ?? defaultInsertPosition(stages), stages.length);
      const created = await tx.pipelineStage.create({
        data: {
          pipelineId,
          name: body.name,
          slug,
          position: insertAt,
          ...(body.color ? { color: body.color } : {}),
          isWon: Boolean(body.isWon),
          isLost: Boolean(body.isLost),
        },
        select: { id: true, name: true, slug: true, position: true, color: true, isWon: true, isLost: true },
      });
      const ordered = [...stages.slice(0, insertAt), created, ...stages.slice(insertAt)];
      const positioned = await applyPositions(tx, ordered);
      return { stage: positioned[insertAt]!, stages: positioned };
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "pipeline.stage_created",
      entityType: "PipelineStage",
      entityId: result.stage.id,
      metadata: { name: result.stage.name, slug: result.stage.slug },
    });

    return Response.json(
      { stage: toStageDto(result.stage), stages: result.stages.map(toStageDto) },
      { status: 201 },
    );
  } catch (error) {
    return routeErrorResponse(error, "Creating the stage");
  }
}

const reorderSchema = z.object({
  stageIds: z
    .array(z.string().min(1, "Stage ids can't be empty"), {
      required_error: "stageIds is required",
      invalid_type_error: "stageIds must be a list of stage ids",
    })
    .min(1, "stageIds must list the stages in their new order")
    .max(100, "Too many stage ids"),
});

/**
 * Reorder the default pipeline's stages: `stageIds` lists every stage once, in the new order.
 * Built-in funnel stages (new … won) must keep their relative order; anything else may move.
 */
export async function PATCH(req: NextRequest) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("pipeline:manage", req, raw);
    const { stageIds } = reorderSchema.parse(raw);
    const pipelineId = await requireDefaultPipelineId(session.organisationId);

    const stages = await prisma.$transaction(async (tx) => {
      await lockPipeline(tx, pipelineId);
      const current = await listStages(tx, pipelineId);
      const byId = new Map(current.map((s) => [s.id, s]));
      const unique = new Set(stageIds);
      // Ids from another pipeline or workspace are simply not in `byId`.
      if (
        unique.size !== stageIds.length ||
        stageIds.length !== current.length ||
        stageIds.some((id) => !byId.has(id))
      ) {
        throw new RouteError(
          400,
          "stageIds must list every stage of this pipeline exactly once — reload and try again.",
        );
      }
      const ordered = stageIds.map((id) => byId.get(id)!);
      // The AI only moves leads forward by position, so the built-in funnel keeps its order.
      const broken = brokenFunnelPair(
        current.map((s) => s.slug),
        ordered.map((s) => s.slug),
      );
      if (broken) {
        const name = (slug: string) => current.find((s) => s.slug === slug)?.name ?? slug;
        const funnel = FUNNEL_STAGE_SLUGS.filter((slug) => current.some((s) => s.slug === slug))
          .map(name)
          .join(" → ");
        throw new RouteError(
          400,
          `"${name(broken[1])}" can't go above "${name(broken[0])}". The built-in stages keep their order ` +
            `(${funnel}) because the AI only moves leads forward. Your own stages and the ` +
            "disqualified / lost / attended / no-show stages can go anywhere.",
          { code: "FUNNEL_ORDER" },
        );
      }
      return applyPositions(tx, ordered);
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "pipeline.stages_reordered",
      entityType: "Pipeline",
      entityId: pipelineId,
      metadata: { stageIds },
    });

    return Response.json({ stages: stages.map(toStageDto) });
  } catch (error) {
    return routeErrorResponse(error, "Reordering stages");
  }
}
