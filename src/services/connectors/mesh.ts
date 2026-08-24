/**
 * Integration mesh overview for UI / AI Ops.
 */

import { prisma } from "@/lib/db";
import { listConnectorDefinitions } from "@/services/connectors/catalogue";
import { evaluateOrganisationConnectors } from "@/services/connectors/capabilities";
import { ensureBuiltinSkillsSeeded, listSkillsForOrg } from "@/services/connectors/skills";

export async function getIntegrationMeshSnapshot(organisationId: string) {
  const [connectors, recentSyncs, circuits, rateLimits, health, skills, opLogs] =
    await Promise.all([
      evaluateOrganisationConnectors(organisationId),
      prisma.syncRun.findMany({
        where: { organisationId },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
      prisma.connectorCircuitState.findMany({
        where: { organisationId },
      }),
      prisma.connectorRateLimitState.findMany({
        where: { organisationId },
      }),
      prisma.providerHealthEvent.findMany({
        where: { organisationId },
        orderBy: { observedAt: "desc" },
        take: 30,
      }),
      listSkillsForOrg(organisationId),
      prisma.connectorOperationLog.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);

  await ensureBuiltinSkillsSeeded();

  const definitions = listConnectorDefinitions().map((d) => ({
    providerKey: d.providerKey,
    displayName: d.displayName,
    category: d.category,
    version: d.version,
    documentationUrl: d.documentationUrl,
    docsVerifiedAt: d.docsVerifiedAt,
    commercialRestrictions: d.commercialRestrictions ?? [],
    webhookSupport: d.webhookSupport,
  }));

  return {
    definitions,
    connectors,
    recentSyncs,
    circuits,
    rateLimits,
    health,
    skills: skills.map((s) => ({
      id: s.id,
      key: s.key,
      version: s.version,
      name: s.name,
      status: s.status,
      requiredTools: s.requiredTools,
      organisationId: s.organisationId,
    })),
    recentOperations: opLogs,
    limitations: [
      "Phase 15 live publishing worker not implemented",
      "DomainEvent coverage still incomplete for some CRM mutations",
      "Playwright E2E skipped without credentials",
      "No production multi-worker soak",
      "Provider maturity is per-connector — not mesh-wide LIVE_E2E",
    ],
  };
}

export async function getIntegrationOpsForAiOps(organisationId?: string) {
  const where = organisationId ? { organisationId } : {};
  const [byProvider, openCircuits, reauth, failedSyncs, recent429] = await Promise.all([
    prisma.connectorCapabilityState.groupBy({
      by: ["providerKey", "status"],
      where,
      _count: { _all: true },
    }),
    prisma.connectorCircuitState.count({
      where: { ...where, state: "OPEN" },
    }),
    prisma.providerHealthEvent.count({
      where: {
        ...where,
        status: { in: ["REAUTH_REQUIRED", "EXPIRED"] },
        observedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
      },
    }),
    prisma.syncRun.count({
      where: { ...where, status: "FAILED" },
    }),
    prisma.connectorRateLimitState.count({
      where: {
        ...where,
        last429At: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
    }),
  ]);

  return {
    capabilityCounts: byProvider,
    openCircuits,
    reauthEvents7d: reauth,
    failedSyncs,
    rateLimit429_24h: recent429,
  };
}
