import { prisma } from "@/lib/db";
import { getBusinessProfile } from "@/services/digital-twin";
import { retrieveRelevantKnowledge } from "@/services/knowledge";

export type ContextItem = {
  source: "state" | "goal" | "opportunity" | "decision" | "claim" | "knowledge" | "business_profile";
  priority: number;
  estimatedTokens: number;
  freshness: string;
  reason: string;
  content: string;
};

export type ContextPlan = {
  items: ContextItem[];
  maxTokens: number;
  estimatedTokens: number;
  truncated: boolean;
};

function tokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function item(input: Omit<ContextItem, "estimatedTokens">): ContextItem {
  return { ...input, estimatedTokens: tokens(input.content) };
}

function bounded(value: unknown, maxChars = 1_600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export async function planContext(input: {
  organisationId: string;
  missionId?: string;
  goalId?: string;
  opportunityId?: string;
  decisionId?: string;
  entityType?: string;
  entityId?: string;
  risk?: string;
  maxTokens?: number;
}): Promise<ContextPlan> {
  const maxTokens = Math.max(1, input.maxTokens ?? 4_000);
  const mission = input.missionId
    ? await prisma.agentMission.findFirst({
        where: { id: input.missionId, organisationId: input.organisationId },
        select: { goalId: true, businessOpportunityId: true, decisionId: true, objectiveSummary: true },
      })
    : null;
  const goalId = input.goalId ?? mission?.goalId ?? undefined;
  const opportunityId = input.opportunityId ?? mission?.businessOpportunityId ?? undefined;
  const decisionId = input.decisionId ?? mission?.decisionId ?? undefined;
  const knowledgeQuery = [
    mission?.objectiveSummary,
    input.entityType && input.entityId ? `${input.entityType} ${input.entityId}` : null,
    input.risk ? `risk ${input.risk}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const [states, goal, opportunity, decision, claims, knowledge, profile] = await Promise.all([
    input.entityType && input.entityId
      ? prisma.stateSnapshot.findMany({
          where: {
            organisationId: input.organisationId,
            entityType: input.entityType,
            entityId: input.entityId,
          },
          select: { dimension: true, value: true, numericValue: true, reasonCode: true, asOf: true },
          orderBy: { asOf: "desc" },
          take: 12,
        })
      : Promise.resolve([]),
    goalId
      ? prisma.goal.findFirst({
          where: { id: goalId, organisationId: input.organisationId },
          select: { name: true, description: true, status: true, priority: true, targetAt: true, updatedAt: true },
        })
      : null,
    opportunityId
      ? prisma.businessOpportunity.findFirst({
          where: { id: opportunityId, organisationId: input.organisationId },
          select: {
            title: true,
            summary: true,
            status: true,
            impact: true,
            urgency: true,
            confidence: true,
            priorityScore: true,
            updatedAt: true,
          },
        })
      : null,
    decisionId
      ? prisma.decision.findFirst({
          where: { id: decisionId, organisationId: input.organisationId },
          select: {
            problemSummary: true,
            status: true,
            riskBand: true,
            confidenceBand: true,
            rationaleSummary: true,
            updatedAt: true,
          },
        })
      : null,
    prisma.intelligenceClaim.findMany({
      where: {
        organisationId: input.organisationId,
        status: { in: ["CORROBORATED", "EXTRACTED"] },
      },
      select: { text: true, status: true, claimKind: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
    knowledgeQuery
      ? retrieveRelevantKnowledge({
          organisationId: input.organisationId,
          query: knowledgeQuery,
          limit: 2,
        }).catch(() => null)
      : null,
    getBusinessProfile(input.organisationId).catch(() => null),
  ]);

  const candidates: ContextItem[] = [];
  if (profile?.organisation?.name) {
    candidates.push(
      item({
        source: "business_profile",
        priority: 98,
        freshness: profile.organisation.updatedAt?.toISOString?.() ?? new Date().toISOString(),
        reason: "Approved business profile",
        content: bounded({
          company: profile.organisation.name,
          products: profile.products.slice(0, 5).map((p) => p.name),
          audiences: profile.audiences.slice(0, 5).map((a) => a.name),
          competitors: profile.competitors.length,
          goals: profile.goals.slice(0, 5).map((g) => g.name),
        }),
      }),
    );
  }
  for (const state of states) {
    candidates.push(
      item({
        source: "state",
        priority: 100,
        freshness: state.asOf.toISOString(),
        reason: `Current ${state.dimension} business state`,
        content: bounded(state, 600),
      }),
    );
  }
  if (decision)
    candidates.push(
      item({
        source: "decision",
        priority: 95,
        freshness: decision.updatedAt.toISOString(),
        reason: "Linked decision memory",
        content: bounded(decision),
      }),
    );
  if (goal)
    candidates.push(
      item({
        source: "goal",
        priority: 90,
        freshness: goal.updatedAt.toISOString(),
        reason: "Linked business goal",
        content: bounded(goal),
      }),
    );
  if (opportunity)
    candidates.push(
      item({
        source: "opportunity",
        priority: 85,
        freshness: opportunity.updatedAt.toISOString(),
        reason: "Linked business opportunity",
        content: bounded(opportunity),
      }),
    );
  for (const claim of claims) {
    candidates.push(
      item({
        source: "claim",
        priority: claim.status === "CORROBORATED" ? 80 : 65,
        freshness: claim.updatedAt.toISOString(),
        reason: `Recent ${claim.status.toLowerCase()} intelligence claim`,
        content: bounded({ kind: claim.claimKind, text: claim.text }, 800),
      }),
    );
  }
  for (const chunk of knowledge?.chunks ?? []) {
    candidates.push(
      item({
        source: "knowledge",
        priority: 55,
        freshness: new Date().toISOString(),
        reason: `Light ${knowledge?.mode ?? "lexical"} knowledge retrieval`,
        content: bounded(chunk, 1_000),
      }),
    );
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const items: ContextItem[] = [];
  let used = 0;
  let truncated = false;
  for (const candidate of candidates) {
    const remaining = maxTokens - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (candidate.estimatedTokens <= remaining) {
      items.push(candidate);
      used += candidate.estimatedTokens;
      continue;
    }
    const content = candidate.content.slice(0, remaining * 4);
    if (content) {
      items.push({ ...candidate, content, estimatedTokens: tokens(content) });
      used += tokens(content);
    }
    truncated = true;
    break;
  }
  return { items, maxTokens, estimatedTokens: used, truncated };
}
