import { getBusinessProfile } from "@/services/digital-twin";
import { planContext, type ContextPlan } from "@/services/context-resolver";

export type AskBusinessContext = {
  plan: ContextPlan;
  knownFacts: string[];
  hasCompany: boolean;
  hasProducts: boolean;
  hasAudience: boolean;
  hasCompetitors: boolean;
  hasGoals: boolean;
};

/**
 * Consult Context Resolver + Business Profile before asking for business info.
 */
export async function resolveAskBusinessContext(input: {
  organisationId: string;
  request: string;
}): Promise<AskBusinessContext> {
  const [plan, profile] = await Promise.all([
    planContext({
      organisationId: input.organisationId,
      risk: "ask",
      entityType: "organisation",
      entityId: input.organisationId,
      maxTokens: 3_000,
    }),
    getBusinessProfile(input.organisationId),
  ]);

  const knownFacts: string[] = [];
  if (profile.organisation?.name) {
    knownFacts.push(`company:${profile.organisation.name}`);
  }
  if (profile.products.length) {
    knownFacts.push(`products:${profile.products.map((p) => p.name).filter(Boolean).slice(0, 5).join(", ")}`);
  }
  if (profile.audiences.length) {
    knownFacts.push(
      `audiences:${profile.audiences.map((a) => a.name).filter(Boolean).slice(0, 5).join(", ")}`,
    );
  }
  if (profile.competitors.length) {
    knownFacts.push(`competitors:${profile.competitors.length}`);
  }
  if (profile.goals.length) {
    knownFacts.push(`goals:${profile.goals.map((g) => g.name).slice(0, 5).join(", ")}`);
  }
  for (const item of plan.items) {
    if (item.source === "knowledge" || item.source === "claim" || item.source === "state") {
      knownFacts.push(`${item.source}:${item.reason}`);
    }
  }

  return {
    plan,
    knownFacts,
    hasCompany: Boolean(profile.organisation?.name),
    hasProducts: profile.products.length > 0,
    hasAudience: profile.audiences.length > 0,
    hasCompetitors: profile.competitors.length > 0,
    hasGoals: profile.goals.length > 0,
  };
}

const BUSINESS_INFO_PATTERNS: Array<{
  re: RegExp;
  coveredBy: (ctx: AskBusinessContext) => boolean;
}> = [
  {
    re: /\b(industry|niche|what (do )?you (sell|offer)|what (is|are) your (business|company|product))\b/i,
    coveredBy: (ctx) => ctx.hasCompany || ctx.hasProducts,
  },
  {
    re: /\b(who (is|are) your (customer|audience|buyer)|target (market|audience)|ideal customer)\b/i,
    coveredBy: (ctx) => ctx.hasAudience,
  },
  {
    re: /\b(competitor|who (do )?you compete)\b/i,
    coveredBy: (ctx) => ctx.hasCompetitors,
  },
  {
    re: /\b(goal|objective|what (are )?you (trying|looking) to (achieve|grow))\b/i,
    coveredBy: (ctx) => ctx.hasGoals,
  },
];

/**
 * Suppress clarifications that ask for business info already in Context Resolver / profile.
 */
export function shouldSuppressBusinessClarification(
  question: string,
  ctx: AskBusinessContext,
): boolean {
  for (const rule of BUSINESS_INFO_PATTERNS) {
    if (rule.re.test(question) && rule.coveredBy(ctx)) {
      return true;
    }
  }
  // Generic "tell me about your business" when we already have profile signal.
  if (
    /\b(tell me (more )?about (your|the) business|what (does|do) (your|the) (company|business))\b/i.test(
      question,
    ) &&
    (ctx.hasCompany || ctx.hasProducts || ctx.knownFacts.length > 0)
  ) {
    return true;
  }
  return false;
}

export function filterClarificationOptionsAgainstContext(
  question: string,
  options: string[],
  ctx: AskBusinessContext,
): { suppressEntirely: boolean; options: string[] } {
  if (shouldSuppressBusinessClarification(question, ctx)) {
    return { suppressEntirely: true, options: [] };
  }
  return { suppressEntirely: false, options };
}
