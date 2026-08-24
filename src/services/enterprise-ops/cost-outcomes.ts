/**
 * Phase 18 — Cost ↔ outcome links.
 * Attribution: UNKNOWN | ESTIMATED | DIRECT — never invent revenue.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";

export const COST_ATTRIBUTIONS = ["UNKNOWN", "ESTIMATED", "DIRECT"] as const;
export type CostAttribution = (typeof COST_ATTRIBUTIONS)[number];

export function isCostAttribution(value: string): value is CostAttribution {
  return (COST_ATTRIBUTIONS as readonly string[]).includes(value);
}

export class CostOutcomeHonestyError extends Error {
  readonly code = "COST_OUTCOME_HONESTY";
  constructor(message: string) {
    super(message);
    this.name = "CostOutcomeHonestyError";
  }
}

/**
 * Record a cost–outcome link. Revenue fields are forbidden unless attribution is DIRECT
 * and an explicit outcome value is supplied by the caller (never invented here).
 */
export async function recordCostOutcomeLink(input: {
  organisationId: string;
  costCents: number;
  costKind: string;
  outcomeKind: string;
  outcomeRef?: string | null;
  attribution?: CostAttribution;
  metadata?: Record<string, unknown>;
  actorUserId?: string | null;
  /** Optional measured outcome amount — must not be fabricated by this service */
  measuredOutcomeValue?: number | null;
}) {
  if (!Number.isFinite(input.costCents) || input.costCents < 0) {
    throw new CostOutcomeHonestyError("costCents must be a non-negative number");
  }

  const attribution: CostAttribution = input.attribution ?? "UNKNOWN";
  if (!isCostAttribution(attribution)) {
    throw new CostOutcomeHonestyError(`Invalid attribution: ${attribution}`);
  }

  const meta = { ...(input.metadata ?? {}) };

  // Never invent revenue
  if ("revenueCents" in meta || "inventedRevenue" in meta) {
    throw new CostOutcomeHonestyError(
      "Do not pass invented revenue fields — supply measuredOutcomeValue only when real",
    );
  }

  if (input.measuredOutcomeValue != null) {
    if (attribution === "UNKNOWN") {
      throw new CostOutcomeHonestyError(
        "measuredOutcomeValue requires ESTIMATED or DIRECT attribution",
      );
    }
    meta.measuredOutcomeValue = input.measuredOutcomeValue;
  }

  if (attribution === "DIRECT" && input.measuredOutcomeValue == null && !input.outcomeRef) {
    throw new CostOutcomeHonestyError(
      "DIRECT attribution requires outcomeRef and/or measuredOutcomeValue",
    );
  }

  const row = await prisma.costOutcomeLink.create({
    data: {
      organisationId: input.organisationId,
      costCents: Math.floor(input.costCents),
      costKind: input.costKind,
      outcomeKind: input.outcomeKind,
      outcomeRef: input.outcomeRef ?? null,
      attribution,
      metadata: meta as Prisma.InputJsonValue,
    },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId,
    action: "enterprise.cost_outcome.recorded",
    entityType: "CostOutcomeLink",
    entityId: row.id,
    metadata: {
      costCents: row.costCents,
      costKind: row.costKind,
      outcomeKind: row.outcomeKind,
      attribution: row.attribution,
    },
  });

  return row;
}

export async function listCostOutcomeLinks(input: {
  organisationId: string;
  take?: number;
}) {
  return prisma.costOutcomeLink.findMany({
    where: { organisationId: input.organisationId },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, input.take ?? 50)),
  });
}

export function getCostOutcomePolicy() {
  return {
    maturity: "WORKING" as const,
    attributions: COST_ATTRIBUTIONS,
    policy:
      "Never invent revenue. UNKNOWN when link is unclear; ESTIMATED when modelled; DIRECT only with real outcome ref/value.",
  };
}
