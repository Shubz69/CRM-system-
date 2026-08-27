/**
 * Phase 20B — deterministic Business State Engine.
 * Maturity: WORKING (local deterministic path).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getStateCalculator,
  type BusinessStateFacts,
} from "@/services/business-state/calculators";
import {
  ensureStateDefinitions,
  getStateDefinition,
  STATE_DEFINITIONS,
} from "@/services/business-state/definitions";

export const BUSINESS_STATE_MATURITY = "WORKING" as const;

export type StateEvidenceInput = {
  evidenceKind: string;
  evidenceId: string;
  note?: string;
};

export type ApplyStateUpdateInput = {
  organisationId: string;
  entityType: string;
  entityId: string;
  dimension: string;
  value: string;
  numericValue?: number;
  reasonCode?: string;
  evidenceLinks?: StateEvidenceInput[];
  triggeredByEventId?: string;
};

function normaliseUpdate(input: ApplyStateUpdateInput): ApplyStateUpdateInput {
  return {
    ...input,
    entityType: input.entityType.trim().toUpperCase(),
    dimension: input.dimension.trim().toUpperCase(),
    value: input.value.trim().toUpperCase(),
  };
}

export async function applyStateUpdate(rawInput: ApplyStateUpdateInput) {
  const input = normaliseUpdate(rawInput);
  if (!input.organisationId || !input.entityId || !input.value) {
    throw new Error("organisationId, entityId, and value are required");
  }

  return prisma.$transaction(async (tx) => {
    const where = {
      organisationId_entityType_entityId_dimension: {
        organisationId: input.organisationId,
        entityType: input.entityType,
        entityId: input.entityId,
        dimension: input.dimension,
      },
    };
    const current = await tx.stateSnapshot.findUnique({ where });
    if (current?.value === input.value) {
      return { changed: false as const, snapshot: current, transition: null };
    }

    const definition = await tx.stateDefinition.findUnique({
      where: {
        entityType_dimension: {
          entityType: input.entityType,
          dimension: input.dimension,
        },
      },
      select: { id: true },
    });
    const now = new Date();
    const snapshot = await tx.stateSnapshot.upsert({
      where,
      create: {
        organisationId: input.organisationId,
        entityType: input.entityType,
        entityId: input.entityId,
        dimension: input.dimension,
        stateDefinitionId: definition?.id,
        value: input.value,
        numericValue: input.numericValue,
        reasonCode: input.reasonCode,
        asOf: now,
      },
      update: {
        stateDefinitionId: definition?.id,
        value: input.value,
        numericValue: input.numericValue,
        reasonCode: input.reasonCode,
        asOf: now,
      },
    });
    const transition = await tx.stateTransition.create({
      data: {
        organisationId: input.organisationId,
        entityType: input.entityType,
        entityId: input.entityId,
        dimension: input.dimension,
        fromValue: current?.value,
        toValue: input.value,
        reasonCode: input.reasonCode,
        fromSnapshotId: current?.id,
        toSnapshotId: snapshot.id,
        triggeredByEventId: input.triggeredByEventId,
      },
    });

    if (input.evidenceLinks?.length) {
      await tx.stateEvidenceLink.createMany({
        data: input.evidenceLinks.map((link) => ({
          organisationId: input.organisationId,
          snapshotId: snapshot.id,
          evidenceKind: link.evidenceKind,
          evidenceId: link.evidenceId,
          note: link.note,
        })),
        skipDuplicates: true,
      });
    }

    return { changed: true as const, snapshot, transition };
  });
}

export type RecomputeEntityStateInput = {
  organisationId: string;
  entityType: string;
  entityId: string;
  facts: BusinessStateFacts;
  dimensions?: string[];
  evidenceLinks?: StateEvidenceInput[];
  triggeredByEventId?: string;
};

export async function recomputeEntityState(input: RecomputeEntityStateInput) {
  const entityType = input.entityType.trim().toUpperCase();
  const dimensions = input.dimensions?.map((dimension) => dimension.toUpperCase());
  const definitions = STATE_DEFINITIONS.filter(
    (definition) =>
      definition.entityType === entityType &&
      (!dimensions || dimensions.includes(definition.dimension)),
  );

  const results = [];
  for (const definition of definitions) {
    const calculator = getStateCalculator(definition.calculatorKey);
    if (!calculator) continue;
    const calculated = calculator(input.facts);
    results.push(
      await applyStateUpdate({
        organisationId: input.organisationId,
        entityType,
        entityId: input.entityId,
        dimension: definition.dimension,
        ...calculated,
        evidenceLinks: input.evidenceLinks,
        triggeredByEventId: input.triggeredByEventId,
      }),
    );
  }
  return results;
}

export type StateSnapshotFilter = {
  entityType?: string;
  entityId?: string;
  dimension?: string;
};

export function listStateSnapshots(
  organisationId: string,
  filter: StateSnapshotFilter = {},
) {
  const where: Prisma.StateSnapshotWhereInput = {
    organisationId,
    entityType: filter.entityType?.toUpperCase(),
    entityId: filter.entityId,
    dimension: filter.dimension?.toUpperCase(),
  };
  return prisma.stateSnapshot.findMany({
    where,
    include: { evidenceLinks: true, stateDefinition: true },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }, { dimension: "asc" }],
  });
}

export {
  ensureStateDefinitions,
  getStateDefinition,
  STATE_DEFINITIONS,
  type BusinessStateFacts,
};
export * from "@/services/business-state/calculators";
