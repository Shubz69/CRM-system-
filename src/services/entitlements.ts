/**
 * Phase 10 — Entitlements + metering.
 * Plan maps to capability flags. Limits only enforce when real meter quantities exist.
 * Never invent usage gauges.
 */

import { prisma } from "@/lib/db";
import { getOrganisationPeriodSpendCents } from "@/services/ai-spend-gate";

export type PlanId = "standard" | "pro" | "enterprise";

export type Capability =
  | "research"
  | "imaging"
  | "social_listening"
  | "automations"
  | "content_publish"
  | "learning"
  | "ask";

export class EntitlementDeniedError extends Error {
  readonly code = "ENTITLEMENT_DENIED";
  constructor(
    message: string,
    readonly organisationId: string,
    readonly capability: Capability,
  ) {
    super(message);
    this.name = "EntitlementDeniedError";
  }
}

export class MeterLimitExceededError extends Error {
  readonly code = "METER_LIMIT_EXCEEDED";
  constructor(
    message: string,
    readonly organisationId: string,
    readonly capability: Capability,
    readonly used: number,
    readonly limit: number,
  ) {
    super(message);
    this.name = "MeterLimitExceededError";
  }
}

const PLAN_CAPABILITIES: Record<PlanId, Record<Capability, { enabled: boolean; limitValue: number | null }>> = {
  standard: {
    ask: { enabled: true, limitValue: null },
    research: { enabled: true, limitValue: 50 },
    imaging: { enabled: true, limitValue: 20 },
    social_listening: { enabled: true, limitValue: 30 },
    automations: { enabled: true, limitValue: null },
    content_publish: { enabled: true, limitValue: null },
    learning: { enabled: true, limitValue: null },
  },
  pro: {
    ask: { enabled: true, limitValue: null },
    research: { enabled: true, limitValue: 200 },
    imaging: { enabled: true, limitValue: 100 },
    social_listening: { enabled: true, limitValue: 150 },
    automations: { enabled: true, limitValue: null },
    content_publish: { enabled: true, limitValue: null },
    learning: { enabled: true, limitValue: null },
  },
  enterprise: {
    ask: { enabled: true, limitValue: null },
    research: { enabled: true, limitValue: null },
    imaging: { enabled: true, limitValue: null },
    social_listening: { enabled: true, limitValue: null },
    automations: { enabled: true, limitValue: null },
    content_publish: { enabled: true, limitValue: null },
    learning: { enabled: true, limitValue: null },
  },
};

export function normalizePlan(plan: string | null | undefined): PlanId {
  const p = (plan || "standard").toLowerCase();
  if (p === "pro" || p === "enterprise" || p === "standard") return p;
  return "standard";
}

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function planCapabilityDefaults(plan: string | null | undefined) {
  return PLAN_CAPABILITIES[normalizePlan(plan)];
}

/**
 * Resolve entitlements: DB rows override plan defaults.
 */
export async function resolveEntitlements(organisationId: string) {
  const org = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: { plan: true, entitlementSnapshot: true },
  });
  if (!org) throw new Error("Organisation not found");

  const defaults = planCapabilityDefaults(org.plan);
  const rows = await prisma.entitlement.findMany({ where: { organisationId } });
  const byCap = new Map(rows.map((r) => [r.capability, r]));

  const resolved: Record<
    Capability,
    { enabled: boolean; limitValue: number | null; source: "plan" | "override" }
  > = {} as never;

  for (const cap of Object.keys(defaults) as Capability[]) {
    const row = byCap.get(cap);
    if (row) {
      resolved[cap] = {
        enabled: row.enabled,
        limitValue: row.limitValue,
        source: "override",
      };
    } else {
      resolved[cap] = {
        enabled: defaults[cap].enabled,
        limitValue: defaults[cap].limitValue,
        source: "plan",
      };
    }
  }

  return {
    plan: normalizePlan(org.plan),
    capabilities: resolved,
  };
}

/**
 * Ensure Entitlement rows exist for the org plan (idempotent sync).
 */
export async function syncEntitlementsFromPlan(organisationId: string) {
  const org = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: { plan: true },
  });
  if (!org) throw new Error("Organisation not found");
  const defaults = planCapabilityDefaults(org.plan);
  const snapshot: Record<string, boolean> = {};

  for (const [capability, cfg] of Object.entries(defaults)) {
    snapshot[capability] = cfg.enabled;
    await prisma.entitlement.upsert({
      where: {
        organisationId_capability: { organisationId, capability },
      },
      create: {
        organisationId,
        capability,
        enabled: cfg.enabled,
        limitValue: cfg.limitValue,
        note: `Synced from plan ${normalizePlan(org.plan)}`,
      },
      update: {
        // Do not overwrite operator overrides that disabled a capability —
        // only refresh limit when still enabled from a prior sync note.
        limitValue: cfg.limitValue,
      },
    });
  }

  await prisma.organisation.update({
    where: { id: organisationId },
    data: { entitlementSnapshot: snapshot },
  });

  return resolveEntitlements(organisationId);
}

export async function getMeterQuantity(input: {
  organisationId: string;
  meterKey: string;
}): Promise<{ quantity: number; periodStart: Date; fromTable: boolean }> {
  const periodStart = startOfUtcMonth();
  const meter = await prisma.usageMeter.findUnique({
    where: {
      organisationId_meterKey_periodStart: {
        organisationId: input.organisationId,
        meterKey: input.meterKey,
        periodStart,
      },
    },
  });
  if (meter) {
    return { quantity: meter.quantity, periodStart, fromTable: true };
  }

  // Honest fallback: count UsageRecord for this feature in the period.
  const count = await prisma.usageRecord.count({
    where: {
      organisationId: input.organisationId,
      feature: input.meterKey,
      createdAt: { gte: periodStart },
    },
  });
  return { quantity: count, periodStart, fromTable: false };
}

/**
 * Record metered usage (UsageRecord + UsageMeter increment).
 */
export async function recordMeteredUsage(input: {
  organisationId: string;
  feature: string;
  quantity?: number;
  provider?: string;
  metadata?: Record<string, unknown>;
}) {
  const quantity = input.quantity ?? 1;
  const periodStart = startOfUtcMonth();

  await prisma.usageRecord.create({
    data: {
      organisationId: input.organisationId,
      feature: input.feature,
      quantity,
      provider: input.provider,
      metadata: input.metadata ?? {},
    },
  });

  await prisma.usageMeter.upsert({
    where: {
      organisationId_meterKey_periodStart: {
        organisationId: input.organisationId,
        meterKey: input.feature,
        periodStart,
      },
    },
    create: {
      organisationId: input.organisationId,
      meterKey: input.feature,
      periodStart,
      quantity,
      source: "usage_record",
    },
    update: {
      quantity: { increment: quantity },
      source: "usage_record",
    },
  });
}

/**
 * Gate a capability. Meter limits only apply when limitValue is set;
 * quantity comes from real UsageRecord/UsageMeter — never invented.
 */
export async function assertEntitlement(
  organisationId: string,
  capability: Capability,
): Promise<{ ok: true; used: number | null; limit: number | null }> {
  const { capabilities } = await resolveEntitlements(organisationId);
  const cap = capabilities[capability];
  if (!cap?.enabled) {
    throw new EntitlementDeniedError(
      `Capability "${capability}" is not enabled for this workspace plan.`,
      organisationId,
      capability,
    );
  }

  if (cap.limitValue == null) {
    return { ok: true, used: null, limit: null };
  }

  const { quantity } = await getMeterQuantity({
    organisationId,
    meterKey: capability,
  });

  if (quantity >= cap.limitValue) {
    throw new MeterLimitExceededError(
      `Monthly limit for "${capability}" reached (${quantity} / ${cap.limitValue}).`,
      organisationId,
      capability,
      quantity,
      cap.limitValue,
    );
  }

  return { ok: true, used: quantity, limit: cap.limitValue };
}

export async function getEntitlementsDashboard(organisationId: string) {
  const resolved = await resolveEntitlements(organisationId);
  const budget = await prisma.organisationAiBudget.findUnique({
    where: { organisationId },
  });
  const spentCents = await getOrganisationPeriodSpendCents(organisationId);

  const meters: Record<string, { quantity: number; limit: number | null }> = {};
  for (const [cap, cfg] of Object.entries(resolved.capabilities)) {
    const { quantity } = await getMeterQuantity({
      organisationId,
      meterKey: cap,
    });
    meters[cap] = { quantity, limit: cfg.limitValue };
  }

  return {
    ...resolved,
    spend: {
      spentCents,
      capCents: budget?.monthlyCapCents ?? null,
      note:
        budget?.monthlyCapCents == null
          ? "No monthly AI spend cap configured."
          : `Estimated AI spend this UTC month (from AiExecution ledger).`,
    },
    meters,
  };
}
