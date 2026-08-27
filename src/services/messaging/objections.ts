import { prisma } from "@/lib/db";

export const CONTROLLED_CATEGORIES = [
  "PRICE",
  "TRUST",
  "TIMING",
  "AUTHORITY",
  "NEED",
  "IMPLEMENTATION",
  "COMPETITOR",
  "FEATURE",
  "RISK",
  "OTHER",
] as const;

export type ObjectionCategory = (typeof CONTROLLED_CATEGORIES)[number];

const CATEGORY_ALIASES: Record<string, ObjectionCategory> = {
  COST: "PRICE",
  EXPENSIVE: "PRICE",
  BUDGET: "PRICE",
  CREDIBILITY: "TRUST",
  LATER: "TIMING",
  URGENCY: "TIMING",
  DECISION_MAKER: "AUTHORITY",
  APPROVAL: "AUTHORITY",
  FIT: "NEED",
  VALUE: "NEED",
  COMPLEXITY: "IMPLEMENTATION",
  INTEGRATION: "IMPLEMENTATION",
  ALTERNATIVE: "COMPETITOR",
  COMPETITION: "COMPETITOR",
  CAPABILITY: "FEATURE",
  MISSING_FEATURE: "FEATURE",
  SECURITY: "RISK",
  LIABILITY: "RISK",
};

export function normalizeObjectionCategory(raw: string): ObjectionCategory {
  const normalized = raw.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if ((CONTROLLED_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ObjectionCategory;
  }
  if (/(PRICE|COST|BUDGET|EXPENSIVE)/.test(normalized)) return "PRICE";
  if (/(TRUST|CREDIB)/.test(normalized)) return "TRUST";
  if (/(^|_)RISK(_|$)|SECURITY|LIABILIT/.test(normalized)) return "RISK";
  if (/(TIME|LATER|URGENT)/.test(normalized)) return "TIMING";
  if (/(AUTHORITY|DECISION_MAKER|APPROVAL)/.test(normalized)) return "AUTHORITY";
  if (/(IMPLEMENT|COMPLEX|INTEGRAT)/.test(normalized)) return "IMPLEMENTATION";
  if (/(FEATURE|CAPABILIT|MISSING_FEATURE)/.test(normalized)) return "FEATURE";
  if (/(COMPET|ALTERNATIVE)/.test(normalized)) return "COMPETITOR";
  return CATEGORY_ALIASES[normalized] ?? "OTHER";
}

export async function recordObjection(input: {
  organisationId: string;
  conversationId: string;
  category: string;
  evidenceMessageId: string;
  text?: string;
}) {
  const category = normalizeObjectionCategory(input.category);
  const text = input.text?.trim() || category;
  const existing = await prisma.objection.findFirst({
    where: {
      organisationId: input.organisationId,
      conversationId: input.conversationId,
      category,
      text,
    },
  });

  // evidenceMessageId is accepted now; the separately managed schema change will
  // provide its dedicated persistence column without changing this public API.
  void input.evidenceMessageId;

  if (existing) {
    return prisma.objection.update({
      where: { id: existing.id },
      data: { detectedAt: new Date() },
    });
  }

  return prisma.objection.create({
    data: {
      organisationId: input.organisationId,
      conversationId: input.conversationId,
      category,
      text,
    },
  });
}

export function shouldRaiseEvidenceDebt(count: number): boolean {
  return Number.isFinite(count) && count >= 5;
}
