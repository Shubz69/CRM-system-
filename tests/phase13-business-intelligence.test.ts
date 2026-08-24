/**
 * Phase 13 — Goal / Twin / Opportunity integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";
import { prisma } from "@/lib/db";
import {
  attachKpiTarget,
  createGoal,
  createKpiDefinition,
  evaluateTargetProgress,
  listKpiHistory,
  refreshKpiFromCalculator,
  transitionGoalStatus,
} from "@/services/goals";
import { InvalidGoalTransitionError } from "@/services/goals/state";
import {
  createAudienceSegment,
  createEntityRelation,
  createProductOffering,
  getBusinessContextCompleteness,
  getBusinessProfile,
} from "@/services/digital-twin";
import {
  acceptOpportunityAsMission,
  computePriorityScore,
  deriveConfidence,
  getOpportunityForOrg,
  listOpportunities,
  runOpportunityDetectorsForOrg,
  transitionOpportunity,
  upsertDetectedOpportunity,
} from "@/services/opportunities";
import { buildChiefOfStaffFacts } from "@/services/chief-of-staff";

describe("Phase 13 business intelligence", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;

  beforeAll(async () => {
    orgA = await createTestOrganisation("p13-a");
    orgB = await createTestOrganisation("p13-b");
  }, 60_000);

  afterAll(async () => {
    await destroyTestOrganisation(orgA);
    await destroyTestOrganisation(orgB);
  }, 60_000);

  it("creates goal with atomic GOAL_CREATED event", async () => {
    const goal = await createGoal({
      organisationId: orgA.organisationId,
      name: "Pipeline to £1m",
      category: "PIPELINE",
      createdByUserId: undefined,
    });
    const event = await prisma.domainEvent.findFirst({
      where: {
        organisationId: orgA.organisationId,
        eventType: "GOAL_CREATED",
        aggregateId: goal.id,
      },
    });
    expect(event).toBeTruthy();
    expect(goal.status).toBe("DRAFT");
  });

  it("enforces goal transitions and blocks ACHIEVED without evidence", async () => {
    const goal = await createGoal({
      organisationId: orgA.organisationId,
      name: "Evidence goal",
    });
    await transitionGoalStatus({
      organisationId: orgA.organisationId,
      goalId: goal.id,
      to: "ACTIVE",
    });
    await expect(
      transitionGoalStatus({
        organisationId: orgA.organisationId,
        goalId: goal.id,
        to: "ACHIEVED",
        evidenceMet: false,
      }),
    ).rejects.toThrow(/evidence/i);
    await expect(
      transitionGoalStatus({
        organisationId: orgA.organisationId,
        goalId: goal.id,
        to: "DRAFT",
      }),
    ).rejects.toBeInstanceOf(InvalidGoalTransitionError);
  });

  it("KPI target unit validation + snapshot history + calculator", async () => {
    const goal = await createGoal({
      organisationId: orgA.organisationId,
      name: "Revenue goal",
    });
    await transitionGoalStatus({
      organisationId: orgA.organisationId,
      goalId: goal.id,
      to: "ACTIVE",
    });
    const kpi = await createKpiDefinition({
      organisationId: orgA.organisationId,
      key: `won_rev_${Date.now()}`,
      name: "Won revenue",
      unit: "GBP_CENTS",
      calculatorKey: "won_revenue_cents",
    });
    await expect(
      attachKpiTarget({
        organisationId: orgA.organisationId,
        goalId: goal.id,
        kpiDefinitionId: kpi.id,
        targetValue: 1_000_000_00,
        unit: "COUNT",
      }),
    ).rejects.toThrow(/Unit mismatch/);

    await attachKpiTarget({
      organisationId: orgA.organisationId,
      goalId: goal.id,
      kpiDefinitionId: kpi.id,
      targetValue: 1_000_000_00,
      baselineValue: 0,
      unit: "GBP_CENTS",
      deadlineAt: new Date("2026-12-31T00:00:00.000Z"),
    });

    await prisma.deal.create({
      data: {
        organisationId: orgA.organisationId,
        name: "Won deal",
        status: "WON",
        amountCents: 50_000_00,
        currency: "GBP",
      },
    });

    const snap1 = await refreshKpiFromCalculator({
      organisationId: orgA.organisationId,
      kpiDefinitionId: kpi.id,
    });
    expect(snap1.value).toBe(50_000_00);
    const snap2 = await refreshKpiFromCalculator({
      organisationId: orgA.organisationId,
      kpiDefinitionId: kpi.id,
    });
    const history = await listKpiHistory(orgA.organisationId, kpi.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.map((h) => h.id)).toContain(snap1.id);
    expect(history.map((h) => h.id)).toContain(snap2.id);

    const progress = evaluateTargetProgress({
      comparator: "GTE",
      targetValue: 1_000_000_00,
      currentValue: snap1.value,
      direction: "HIGHER_IS_BETTER",
    });
    expect(progress.behind).toBe(true);
  });

  it("tenant isolation: org B cannot read org A goal", async () => {
    const goal = await createGoal({
      organisationId: orgA.organisationId,
      name: "Private",
    });
    const cross = await prisma.goal.findFirst({
      where: { id: goal.id, organisationId: orgB.organisationId },
    });
    expect(cross).toBeNull();
  });

  it("entity relation + cross-org rejection + completeness", async () => {
    const product = await createProductOffering({
      organisationId: orgA.organisationId,
      name: "Advisory retainer",
    });
    const company = await prisma.company.create({
      data: { organisationId: orgA.organisationId, name: `Rival ${Date.now()}` },
    });
    await createEntityRelation({
      organisationId: orgA.organisationId,
      sourceType: "Organisation",
      sourceId: orgA.organisationId,
      relationshipType: "COMPETES_WITH",
      targetType: "Company",
      targetId: company.id,
      source: "test",
      confidence: 0.8,
    });
    await expect(
      createEntityRelation({
        organisationId: orgA.organisationId,
        sourceType: "Organisation",
        sourceId: orgB.organisationId,
        relationshipType: "COMPETES_WITH",
        targetType: "Company",
        targetId: company.id,
        source: "test",
      }),
    ).rejects.toThrow(/Cross-org|not found/i);

    await createAudienceSegment({
      organisationId: orgA.organisationId,
      name: "CFOs",
      attributes: { role: "CFO", industry: "SaaS" },
      evidenceNote: "From CRM titles",
      confidence: 0.6,
    });
    await expect(
      createAudienceSegment({
        organisationId: orgA.organisationId,
        name: "Bad",
        attributes: { ethnicity: "x" },
      }),
    ).rejects.toThrow(/Sensitive/);

    const completeness = await getBusinessContextCompleteness(orgA.organisationId);
    expect(completeness.items.find((i) => i.key === "products")?.status).toBe("known");
    const profile = await getBusinessProfile(orgA.organisationId);
    expect(profile.products.some((p) => p.id === product.id)).toBe(true);
  });

  it("priority scoring is deterministic", () => {
    const a = computePriorityScore({
      impact: "HIGH",
      urgency: "HIGH",
      confidence: "HIGH",
      goalAlignment: 1.2,
      effortFactor: 1,
    });
    const b = computePriorityScore({
      impact: "HIGH",
      urgency: "HIGH",
      confidence: "HIGH",
      goalAlignment: 1.2,
      effortFactor: 1,
    });
    expect(a.score).toBe(b.score);
    expect(deriveConfidence({ independentSignals: 3, dataFresh: true, sourceQuality: "high" })).toBe(
      "HIGH",
    );
  });

  it("deal risk detector creates opportunity with evidence; dedupes", async () => {
    const deal = await prisma.deal.create({
      data: {
        organisationId: orgA.organisationId,
        name: "Stale whale",
        status: "OPEN",
        amountCents: 80_000_00,
        currency: "GBP",
        updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60_000),
      },
    });
    // Force updatedAt in the past (Prisma @updatedAt may overwrite on create).
    await prisma.deal.update({
      where: { id: deal.id },
      data: { updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60_000) },
    });

    const first = await runOpportunityDetectorsForOrg(orgA.organisationId);
    expect(first.created + first.updated).toBeGreaterThanOrEqual(1);
    const opps = await listOpportunities(orgA.organisationId);
    const dealRisk = opps.find((o) => o.dedupeKey === `deal_risk:v1:${deal.id}`);
    expect(dealRisk).toBeTruthy();
    expect(dealRisk!.evidences.length).toBeGreaterThan(0);

    const second = await runOpportunityDetectorsForOrg(orgA.organisationId);
    expect(second.created).toBe(0);
    const again = await listOpportunities(orgA.organisationId);
    expect(again.filter((o) => o.dedupeKey === `deal_risk:v1:${deal.id}`)).toHaveLength(1);
  }, 60_000);

  it("opportunity accept → mission; cross-org blocked", async () => {
    const { opportunity } = await upsertDetectedOpportunity({
      organisationId: orgA.organisationId,
      type: "CUSTOM",
      title: "Manual opp",
      summary: "Test conversion",
      dedupeKey: `custom:test:${Date.now()}`,
      source: "test",
      impact: "MEDIUM",
      urgency: "MEDIUM",
      confidence: "HIGH",
      evidences: [{ evidenceType: "Test", label: "Fixture evidence" }],
    });

    await expect(
      acceptOpportunityAsMission({
        organisationId: orgB.organisationId,
        opportunityId: opportunity.id,
      }),
    ).rejects.toThrow(/not found/i);

    const result = await acceptOpportunityAsMission({
      organisationId: orgA.organisationId,
      opportunityId: opportunity.id,
    });
    expect(result.missionId).toBeTruthy();
    const mission = await prisma.agentMission.findFirst({
      where: { id: result.missionId, organisationId: orgA.organisationId },
    });
    expect(mission?.businessOpportunityId).toBe(opportunity.id);

    const event = await prisma.domainEvent.findFirst({
      where: {
        organisationId: orgA.organisationId,
        eventType: "OPPORTUNITY_ACCEPTED",
        aggregateId: opportunity.id,
      },
    });
    expect(event).toBeTruthy();
  }, 30_000);

  it("reject opportunity; tenant cannot transition other org", async () => {
    const { opportunity } = await upsertDetectedOpportunity({
      organisationId: orgA.organisationId,
      type: "CUSTOM",
      title: "Reject me",
      summary: "x",
      dedupeKey: `custom:reject:${Date.now()}`,
      source: "test",
      impact: "LOW",
      urgency: "LOW",
      confidence: "LOW",
      evidences: [{ evidenceType: "Test", label: "e" }],
    });
    await expect(
      transitionOpportunity({
        organisationId: orgB.organisationId,
        opportunityId: opportunity.id,
        to: "REJECTED",
      }),
    ).rejects.toThrow(/not found/i);
    await transitionOpportunity({
      organisationId: orgA.organisationId,
      opportunityId: opportunity.id,
      to: "REJECTED",
    });
    const row = await getOpportunityForOrg(orgA.organisationId, opportunity.id);
    expect(row?.status).toBe("REJECTED");
  });

  it("chief of staff excludes other org and surfaces at-risk + opportunities", async () => {
    const goal = await createGoal({
      organisationId: orgA.organisationId,
      name: "At risk goal",
    });
    await transitionGoalStatus({
      organisationId: orgA.organisationId,
      goalId: goal.id,
      to: "ACTIVE",
    });
    await transitionGoalStatus({
      organisationId: orgA.organisationId,
      goalId: goal.id,
      to: "AT_RISK",
    });

    await upsertDetectedOpportunity({
      organisationId: orgA.organisationId,
      type: "DEAL_RISK",
      title: "CoS deal risk",
      summary: "High urgency deal risk for CoS",
      dedupeKey: `cos:deal:${Date.now()}`,
      source: "test",
      impact: "HIGH",
      urgency: "CRITICAL",
      confidence: "HIGH",
      evidences: [{ evidenceType: "Test", label: "evidence" }],
    });

    const factsA = await buildChiefOfStaffFacts(orgA.organisationId);
    expect(factsA.sections.WHAT_IS_AT_RISK.some((f) => f.goalId === goal.id)).toBe(true);
    expect(factsA.sections.OPPORTUNITIES.length).toBeGreaterThan(0);

    const factsB = await buildChiefOfStaffFacts(orgB.organisationId);
    expect(factsB.sections.WHAT_IS_AT_RISK.some((f) => f.goalId === goal.id)).toBe(false);
    expect(
      factsB.sections.OPPORTUNITIES.some((f) =>
        factsA.sections.OPPORTUNITIES.map((x) => x.id).includes(f.id),
      ),
    ).toBe(false);
  });
});
