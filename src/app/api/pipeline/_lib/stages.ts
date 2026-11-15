import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RouteError } from "./http";

/**
 * Stage slugs the product depends on: inbound AI analysis moves leads by these slugs
 * (inbound-pipeline.ts), the stage guard treats booked/won specially (lead-stage-guard.ts),
 * goals count booked/booking_offered, the dashboard counts contacted, and the booking
 * webhook looks up lost/attended/no_show. Stages with these slugs can be renamed,
 * recoloured and reordered — never deleted, and their won/lost meaning is fixed.
 */
export const SYSTEM_STAGE_SLUGS = [
  "new",
  "contacted",
  "engaged",
  "qualifying",
  "qualified",
  "booking_offered",
  "booked",
  "won",
  "disqualified",
  "lost",
  "attended",
  "no_show",
] as const;

const SYSTEM_SLUG_SET = new Set<string>(SYSTEM_STAGE_SLUGS);

export const MAX_STAGES = 30;
export const STAGE_NAME_MAX = 60;

export function isSystemStageSlug(slug: string): boolean {
  return SYSTEM_SLUG_SET.has(slug);
}

/** "Proposal Sent!" → "proposal_sent" (same style as the built-in slugs). */
export function slugifyStageName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  return base || "stage";
}

/**
 * A slug for a new custom stage: derived from the name, never one of the system slugs
 * (so a custom "Lost" stage doesn't silently start receiving cancelled bookings) and
 * unique within the pipeline.
 */
export function uniqueStageSlug(name: string, existingSlugs: Iterable<string>): string {
  const taken = new Set(existingSlugs);
  const base = slugifyStageName(name);
  const free = (slug: string) => !taken.has(slug) && !SYSTEM_SLUG_SET.has(slug);
  if (free(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}_${n}`;
    if (free(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/** Where a new stage goes by default: before the closing won/lost stages at the end. */
export function defaultInsertPosition(stages: Array<{ isWon: boolean; isLost: boolean }>): number {
  let index = stages.length;
  while (index > 0 && (stages[index - 1]!.isWon || stages[index - 1]!.isLost)) index -= 1;
  return index;
}

export const stageColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Colour must be a hex value like #3b82f6");

export const stageNameSchema = z
  .string({
    required_error: "Stage name is required",
    invalid_type_error: "Stage name must be text",
  })
  .trim()
  .min(1, "Stage name is required")
  .max(STAGE_NAME_MAX, `Stage name must be ${STAGE_NAME_MAX} characters or fewer`);

export const STAGE_SELECT = {
  id: true,
  name: true,
  slug: true,
  position: true,
  color: true,
  isWon: true,
  isLost: true,
} as const;

export type StageRow = {
  id: string;
  name: string;
  slug: string;
  position: number;
  color: string;
  isWon: boolean;
  isLost: boolean;
};

export function toStageDto(stage: StageRow) {
  return { ...stage, isSystem: isSystemStageSlug(stage.slug) };
}

type Tx = Prisma.TransactionClient;

/** The workspace's default pipeline (the one the board shows), or a clear 404. */
export async function requireDefaultPipelineId(organisationId: string): Promise<string> {
  const pipeline = await prisma.pipeline.findFirst({
    where: { organisationId, isDefault: true },
    select: { id: true },
  });
  if (!pipeline) {
    throw new RouteError(
      404,
      "This workspace has no default pipeline yet, so its stages can't be edited.",
    );
  }
  return pipeline.id;
}

/** Serialise stage edits per pipeline so positions and slugs stay consistent. */
export async function lockPipeline(tx: Tx, pipelineId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Pipeline" WHERE "id" = ${pipelineId} FOR UPDATE`;
}

export async function listStages(tx: Tx, pipelineId: string): Promise<StageRow[]> {
  return tx.pipelineStage.findMany({
    where: { pipelineId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: STAGE_SELECT,
  });
}

/** Give `ordered` contiguous positions 0..n-1, writing only rows that moved. */
export async function applyPositions(tx: Tx, ordered: StageRow[]): Promise<StageRow[]> {
  const result: StageRow[] = [];
  for (const [index, stage] of ordered.entries()) {
    if (stage.position !== index) {
      await tx.pipelineStage.update({ where: { id: stage.id }, data: { position: index } });
    }
    result.push({ ...stage, position: index });
  }
  return result;
}

export function assertNameFree(stages: StageRow[], name: string, exceptId?: string): void {
  const wanted = name.trim().toLowerCase();
  const clash = stages.find((s) => s.id !== exceptId && s.name.trim().toLowerCase() === wanted);
  if (clash) throw new RouteError(409, `A stage called "${clash.name}" already exists.`);
}
