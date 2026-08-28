/**
 * Phase 13B — Digital Twin services over existing domain entities.
 */

import { BusinessClaimStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  classifyFreshness,
  isTwinEntityType,
  isTwinRelationshipType,
  type FreshnessBand,
} from "@/services/digital-twin/registry";

export async function createEntityRelation(input: {
  organisationId: string;
  sourceType: string;
  sourceId: string;
  relationshipType: string;
  targetType: string;
  targetId: string;
  confidence?: number;
  source: string;
  evidenceReference?: string;
  validFrom?: Date;
  validUntil?: Date;
}) {
  if (!isTwinEntityType(input.sourceType) || !isTwinEntityType(input.targetType)) {
    throw new Error("Invalid entity type");
  }
  if (!isTwinRelationshipType(input.relationshipType)) {
    throw new Error("Invalid relationship type");
  }
  // Tenant isolation: both ends must resolve inside the org when they are org-scoped CRM rows.
  await assertEntityInOrg(input.organisationId, input.sourceType, input.sourceId);
  await assertEntityInOrg(input.organisationId, input.targetType, input.targetId);

  return prisma.entityRelation.create({
    data: {
      organisationId: input.organisationId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      relationshipType: input.relationshipType,
      targetType: input.targetType,
      targetId: input.targetId,
      confidence: input.confidence,
      source: input.source,
      evidenceReference: input.evidenceReference,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    },
  });
}

async function assertEntityInOrg(
  organisationId: string,
  type: string,
  id: string,
): Promise<void> {
  if (type === "Organisation") {
    if (id !== organisationId) throw new Error("Cross-org entity rejected");
    return;
  }
  const checkers: Record<string, () => Promise<unknown>> = {
    Company: () =>
      prisma.company.findFirst({ where: { id, organisationId, deletedAt: null } }),
    Contact: () =>
      prisma.contact.findFirst({ where: { id, organisationId, deletedAt: null } }),
    Lead: () => prisma.lead.findFirst({ where: { id, organisationId, deletedAt: null } }),
    Deal: () => prisma.deal.findFirst({ where: { id, organisationId, deletedAt: null } }),
    Goal: () => prisma.goal.findFirst({ where: { id, organisationId } }),
    KpiDefinition: () => prisma.kpiDefinition.findFirst({ where: { id, organisationId } }),
    Initiative: () => prisma.initiative.findFirst({ where: { id, organisationId } }),
    BusinessOpportunity: () =>
      prisma.businessOpportunity.findFirst({ where: { id, organisationId } }),
    ProductOffering: () =>
      prisma.productOffering.findFirst({ where: { id, organisationId } }),
    AudienceSegment: () =>
      prisma.audienceSegment.findFirst({ where: { id, organisationId } }),
    Campaign: () => prisma.campaign.findFirst({ where: { id, organisationId } }),
    ContentPiece: () => prisma.contentPiece.findFirst({ where: { id, organisationId } }),
    TrendCluster: () => prisma.trendCluster.findFirst({ where: { id, organisationId } }),
    Competitor: () =>
      prisma.company.findFirst({ where: { id, organisationId, deletedAt: null } }),
    Creator: () => prisma.socialCreator.findFirst({ where: { id, organisationId } }),
    Topic: async () => ({ id }), // topics may be free-form keys
  };
  const check = checkers[type];
  if (!check) return;
  const row = await check();
  if (!row) throw new Error(`Entity ${type}:${id} not found in organisation`);
}

export async function createProductOffering(input: {
  organisationId: string;
  name: string;
  description?: string;
  category?: string;
  priceMinCents?: number;
  priceMaxCents?: number;
  currency?: string;
  targetAudience?: string;
  businessModel?: string;
}) {
  return prisma.productOffering.create({
    data: {
      organisationId: input.organisationId,
      name: input.name,
      description: input.description,
      category: input.category,
      priceMinCents: input.priceMinCents,
      priceMaxCents: input.priceMaxCents,
      currency: input.currency ?? "GBP",
      targetAudience: input.targetAudience,
      businessModel: input.businessModel,
    },
  });
}

export async function createAudienceSegment(input: {
  organisationId: string;
  name: string;
  description?: string;
  /** Commercial attributes only — no protected characteristics. */
  attributes?: Record<string, unknown>;
  evidenceNote?: string;
  confidence?: number;
}) {
  const blocked = ["religion", "ethnicity", "health", "sexualOrientation", "politicalBelief"];
  const attrs = input.attributes ?? {};
  for (const key of blocked) {
    if (key in attrs) throw new Error(`Sensitive attribute ${key} is not allowed`);
  }
  return prisma.audienceSegment.create({
    data: {
      organisationId: input.organisationId,
      name: input.name,
      description: input.description,
      attributes: attrs as Prisma.InputJsonValue,
      evidenceNote: input.evidenceNote,
      confidence: input.confidence,
    },
  });
}

export async function upsertBusinessClaim(input: {
  organisationId: string;
  subjectType: string;
  subjectId: string;
  predicate: string;
  valueText?: string;
  status?: BusinessClaimStatus;
  confidence?: number;
  source: string;
  evidenceReference?: string;
  validFrom?: Date;
  validUntil?: Date;
}) {
  await assertEntityInOrg(input.organisationId, input.subjectType, input.subjectId);
  // Temporal: create a new claim row rather than silently rewriting history when values change.
  const latest = await prisma.businessClaim.findFirst({
    where: {
      organisationId: input.organisationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      predicate: input.predicate,
      status: { not: BusinessClaimStatus.DISPUTED },
    },
    orderBy: { observedAt: "desc" },
  });
  if (latest && latest.valueText === input.valueText) {
    return prisma.businessClaim.update({
      where: { id: latest.id },
      data: {
        lastVerifiedAt: new Date(),
        confidence: input.confidence ?? latest.confidence,
        evidenceReference: input.evidenceReference ?? latest.evidenceReference,
      },
    });
  }
  if (latest && input.valueText && latest.valueText !== input.valueText) {
    await prisma.businessClaim.update({
      where: { id: latest.id },
      data: { validUntil: new Date(), status: BusinessClaimStatus.STALE },
    });
  }
  return prisma.businessClaim.create({
    data: {
      organisationId: input.organisationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      predicate: input.predicate,
      valueText: input.valueText,
      status: input.status ?? BusinessClaimStatus.OBSERVED,
      confidence: input.confidence,
      source: input.source,
      evidenceReference: input.evidenceReference,
      validFrom: input.validFrom ?? new Date(),
      validUntil: input.validUntil,
      lastVerifiedAt: new Date(),
    },
  });
}

export type CompletenessItem = {
  key: string;
  label: string;
  status: "known" | "partial" | "missing";
  detail: string;
};

export async function getBusinessContextCompleteness(organisationId: string): Promise<{
  items: CompletenessItem[];
}> {
  const [
    products,
    audiences,
    competitorRels,
    goals,
    kpis,
    linkedIn,
    org,
    brandDocs,
    salesDocs,
    policyDocs,
    knowledgeDocs,
    latestKnowledge,
  ] = await Promise.all([
    prisma.productOffering.count({ where: { organisationId, status: "ACTIVE" } }),
    prisma.audienceSegment.count({ where: { organisationId } }),
    prisma.entityRelation.count({
      where: { organisationId, relationshipType: "COMPETES_WITH" },
    }),
    prisma.goal.count({ where: { organisationId, status: { in: ["ACTIVE", "AT_RISK"] } } }),
    prisma.kpiDefinition.count({ where: { organisationId } }),
    prisma.socialConnection.findFirst({
      where: { organisationId, platform: { in: ["INSTAGRAM", "LINKEDIN"] }, status: "ACTIVE" },
      select: { id: true, updatedAt: true },
    }).catch(() => null),
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { name: true, updatedAt: true },
    }),
    prisma.knowledgeDocument.count({
      where: { organisationId, category: { in: ["tone", "brand"] }, status: "ACTIVE" },
    }),
    prisma.knowledgeDocument.count({
      where: { organisationId, category: { in: ["scripts", "sop"] }, status: "ACTIVE" },
    }),
    prisma.knowledgeDocument.count({
      where: { organisationId, category: { in: ["sop", "faq", "pricing"] }, status: "ACTIVE" },
    }),
    prisma.knowledgeDocument.count({
      where: { organisationId, status: "ACTIVE" },
    }),
    prisma.knowledgeDocument.findFirst({
      where: { organisationId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);

  const orgFresh = org
    ? classifyFreshness(org.updatedAt, "company_description")
    : "UNKNOWN";
  const knowledgeFresh = latestKnowledge
    ? classifyFreshness(latestKnowledge.updatedAt, "default")
    : "UNKNOWN";

  const items: CompletenessItem[] = [
    {
      key: "business",
      label: "Business",
      status: org
        ? orgFresh === "STALE"
          ? "partial"
          : "known"
        : "missing",
      detail: org
        ? `${org.name} · updated ${org.updatedAt.toISOString().slice(0, 10)}`
        : "Organisation profile missing",
    },
    {
      key: "products",
      label: "Products / services",
      status: products > 0 ? "known" : "missing",
      detail: products > 0 ? `${products} active offering(s)` : "No product offerings configured",
    },
    {
      key: "audience",
      label: "Customers / audiences",
      status: audiences > 0 ? "known" : "missing",
      detail: audiences > 0 ? `${audiences} segment(s)` : "No audience segments configured",
    },
    {
      key: "markets",
      label: "Markets / regions",
      status: audiences > 0 ? "partial" : "missing",
      detail:
        audiences > 0
          ? "Audience segments exist — confirm geographic markets"
          : "No markets or regions recorded yet",
    },
    {
      key: "brand",
      label: "Brand",
      status: brandDocs > 0 ? "known" : "missing",
      detail:
        brandDocs > 0
          ? `${brandDocs} brand / tone document(s)`
          : "No brand or tone of voice documents",
    },
    {
      key: "sales",
      label: "Sales approach",
      status: salesDocs > 0 ? "known" : "missing",
      detail:
        salesDocs > 0
          ? `${salesDocs} scripts / process document(s)`
          : "No sales scripts or process docs",
    },
    {
      key: "goals",
      label: "Goals",
      status: goals > 0 ? (kpis > 0 ? "known" : "partial") : "missing",
      detail:
        goals > 0
          ? `${goals} active goal(s)${kpis > 0 ? ` · ${kpis} KPI(s)` : " · add KPIs"}`
          : "No active goals",
    },
    {
      key: "policies",
      label: "Policies",
      status: policyDocs > 0 ? "known" : "missing",
      detail:
        policyDocs > 0
          ? `${policyDocs} policy / FAQ / pricing document(s)`
          : "No policies or pricing guidance stored",
    },
    {
      key: "competitors",
      label: "Competitors",
      status: competitorRels >= 3 ? "known" : competitorRels > 0 ? "partial" : "missing",
      detail:
        competitorRels > 0
          ? `${competitorRels} competitor relationship(s)`
          : "No competitor relationships configured",
    },
    {
      key: "social",
      label: "Social presence",
      status: linkedIn ? "known" : "missing",
      detail: linkedIn
        ? "At least one social channel connected"
        : "No LinkedIn or Instagram connection",
    },
    {
      key: "knowledge_health",
      label: "Knowledge health",
      status:
        knowledgeDocs === 0
          ? "missing"
          : knowledgeFresh === "STALE"
            ? "partial"
            : knowledgeFresh === "AGING"
              ? "partial"
              : "known",
      detail:
        knowledgeDocs === 0
          ? "No active knowledge documents"
          : `${knowledgeDocs} active document(s) · freshness ${knowledgeFresh.toLowerCase()}`,
    },
  ];
  return { items };
}

export async function getBusinessProfile(organisationId: string) {
  const [
    org,
    products,
    audiences,
    competitors,
    goals,
    kpis,
    initiatives,
    completeness,
    claims,
  ] = await Promise.all([
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true, name: true, slug: true, updatedAt: true },
    }),
    prisma.productOffering.findMany({
      where: { organisationId, status: "ACTIVE" },
      take: 20,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.audienceSegment.findMany({
      where: { organisationId },
      take: 20,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.entityRelation.findMany({
      where: { organisationId, relationshipType: "COMPETES_WITH" },
      take: 20,
    }),
    prisma.goal.findMany({
      where: { organisationId, status: { in: ["ACTIVE", "AT_RISK", "DRAFT"] } },
      orderBy: { priority: "asc" },
      take: 20,
    }),
    prisma.kpiDefinition.findMany({ where: { organisationId }, take: 20 }),
    prisma.initiative.findMany({
      where: { organisationId, status: "ACTIVE" },
      take: 20,
    }),
    getBusinessContextCompleteness(organisationId),
    prisma.businessClaim.findMany({
      where: { organisationId, status: { in: ["CONFIRMED", "OBSERVED", "INFERRED"] } },
      orderBy: { observedAt: "desc" },
      take: 30,
    }),
  ]);

  const freshness: Record<string, FreshnessBand> = {
    organisation: classifyFreshness(org?.updatedAt, "company_description"),
    goals: goals[0] ? classifyFreshness(goals[0].updatedAt, "goal") : "UNKNOWN",
  };

  return {
    organisation: org,
    products,
    audiences,
    competitors,
    goals,
    kpis,
    initiatives,
    claims,
    completeness: completeness.items,
    freshness,
    working: {
      note: "Derived from durable CRM/research data only — no invented metrics",
    },
    atRisk: goals.filter((g) => g.status === "AT_RISK"),
  };
}
