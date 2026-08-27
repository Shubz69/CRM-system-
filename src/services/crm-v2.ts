/**
 * Phase 7 CRM V2 — companies, deals, customer 360, attribution honesty, industry templates.
 */

import { DealStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type IndustryTemplateKey =
  | "generic"
  | "agency"
  | "b2b_saas"
  | "creator"
  | "coaching";

export type IndustryTemplate = {
  key: IndustryTemplateKey;
  label: string;
  description: string;
  /** Config only — never forks the product. */
  config: {
    defaultPipelineStages: string[];
    qualificationHints: string[];
    primaryChannels: string[];
    notes: string;
  };
};

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    key: "generic",
    label: "Generic CRM",
    description: "Neutral workspace — no industry assumptions.",
    config: {
      defaultPipelineStages: ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"],
      qualificationHints: ["budget", "timeline", "decision_maker"],
      primaryChannels: ["email", "phone", "web"],
      notes: "Does not assume Instagram DM setter workflows.",
    },
  },
  {
    key: "agency",
    label: "Agency",
    description: "Client retainers and project deals.",
    config: {
      defaultPipelineStages: ["Lead in", "Discovery", "Proposal", "Negotiation", "Retainer", "Lost"],
      qualificationHints: ["retainer_budget", "scope", "start_date"],
      primaryChannels: ["email", "linkedin", "referral"],
      notes: "Company/Account first; deals map to client engagements.",
    },
  },
  {
    key: "b2b_saas",
    label: "B2B SaaS",
    description: "Account-based pipeline with seat/expansion deals.",
    config: {
      defaultPipelineStages: ["MQL", "SQL", "Demo", "Trial", "Closed won", "Closed lost"],
      qualificationHints: ["company_size", "use_case", "tech_stack"],
      primaryChannels: ["email", "linkedin", "product"],
      notes: "Attribution confidence required; last-touch limitations disclosed.",
    },
  },
  {
    key: "creator",
    label: "Creator / Media",
    description: "Brand deals and sponsorship opportunities.",
    config: {
      defaultPipelineStages: ["Inbound", "Pitch", "Negotiation", "Delivered", "Paid", "Lost"],
      qualificationHints: ["budget", "deliverables", "usage_rights"],
      primaryChannels: ["instagram", "email", "youtube"],
      notes: "Social is a channel — not the only CRM shape.",
    },
  },
  {
    key: "coaching",
    label: "Coaching / Services",
    description: "High-touch consultative sales (not forced into IG DMs).",
    config: {
      defaultPipelineStages: ["Inquiry", "Call booked", "Proposal", "Enrolled", "Lost"],
      qualificationHints: ["goal", "budget", "urgency"],
      primaryChannels: ["email", "phone", "calendar"],
      notes: "Lead + Deal can coexist during migration from inbox qualification.",
    },
  },
];

export function getIndustryTemplate(key: string | null | undefined): IndustryTemplate {
  return INDUSTRY_TEMPLATES.find((t) => t.key === key) ?? INDUSTRY_TEMPLATES[0]!;
}

export async function applyIndustryTemplate(input: {
  organisationId: string;
  key: IndustryTemplateKey;
}): Promise<void> {
  const template = getIndustryTemplate(input.key);
  await prisma.organisation.update({
    where: { id: input.organisationId },
    data: {
      industryTemplateKey: template.key,
      industryTemplateConfig: template.config as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function upsertCompany(input: {
  organisationId: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeBand?: string | null;
}): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("Company name is required");

  const existing = await prisma.company.findFirst({
    where: {
      organisationId: input.organisationId,
      name: { equals: name, mode: "insensitive" },
      deletedAt: null,
    },
  });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.company.update({
        where: { id: existing.id },
        data: {
          domain: input.domain ?? existing.domain,
          website: input.website ?? existing.website,
          industry: input.industry ?? existing.industry,
          sizeBand: input.sizeBand ?? existing.sizeBand,
        },
      });
      const { appendDomainEvent } = await import("@/services/domain-events/append");
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "COMPANY_UPDATED",
        aggregateType: "Company",
        aggregateId: existing.id,
        payload: { companyId: existing.id },
        dedupeKey: `COMPANY_UPDATED:${existing.id}:${Date.now()}`,
      });
    });
    return existing.id;
  }

  const row = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        organisationId: input.organisationId,
        name,
        domain: input.domain ?? null,
        website: input.website ?? null,
        industry: input.industry ?? null,
        sizeBand: input.sizeBand ?? null,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "COMPANY_CREATED",
      aggregateType: "Company",
      aggregateId: company.id,
      payload: { companyId: company.id },
      dedupeKey: `COMPANY_CREATED:${company.id}`,
    });
    return company;
  });
  return row.id;
}

export async function createDeal(input: {
  organisationId: string;
  name: string;
  companyId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  amountCents?: number | null;
  currency?: string;
  probability?: number | null;
  stageLabel?: string | null;
  summary?: string | null;
  expectedCloseAt?: Date | null;
}): Promise<string> {
  if (input.probability != null && (input.probability < 0 || input.probability > 1)) {
    throw new Error("Deal probability must be between 0 and 1 (or null if unknown)");
  }
  const row = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        organisationId: input.organisationId,
        name: input.name.trim(),
        companyId: input.companyId ?? null,
        contactId: input.contactId ?? null,
        leadId: input.leadId ?? null,
        amountCents: input.amountCents ?? null,
        currency: input.currency ?? "USD",
        probability: input.probability ?? null,
        stageLabel: input.stageLabel ?? null,
        summary: input.summary ?? null,
        expectedCloseAt: input.expectedCloseAt ?? null,
        status: DealStatus.OPEN,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "DEAL_CREATED",
      aggregateType: "Deal",
      aggregateId: deal.id,
      payload: {
        dealId: deal.id,
        amountCents: deal.amountCents,
        currency: deal.currency,
      },
    });
    return deal;
  });
  return row.id;
}

export async function recordAttribution(input: {
  organisationId: string;
  contactId: string;
  leadId?: string | null;
  dealId?: string | null;
  campaignId?: string | null;
  source?: string | null;
  medium?: string | null;
  content?: string | null;
  confidence?: number | null;
  limitations?: string | null;
  method?: string | null;
}): Promise<string> {
  const confidence = input.confidence ?? null;
  if (confidence != null && (confidence < 0 || confidence > 1)) {
    throw new Error("Attribution confidence must be 0–1 or null");
  }
  const method = input.method?.trim() || "unknown";
  const limitations =
    input.limitations?.trim() ||
    (method === "last_touch"
      ? "Last-touch only; does not model multi-touch journeys."
      : method === "first_touch"
        ? "First-touch only; later assists are not credited."
        : "Attribution method is limited; treat as directional, not proof.");

  const row = await prisma.attribution.create({
    data: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      leadId: input.leadId ?? null,
      dealId: input.dealId ?? null,
      campaignId: input.campaignId ?? null,
      source: input.source ?? null,
      medium: input.medium ?? null,
      content: input.content ?? null,
      confidence,
      limitations,
      method,
    },
  });
  return row.id;
}

/**
 * Customer 360 — evidence from DB only; no sensitive inference.
 */
export async function getCustomer360(input: {
  organisationId: string;
  contactId: string;
}): Promise<{
  contact: unknown;
  company: unknown;
  leads: unknown[];
  deals: unknown[];
  activities: unknown[];
  conversations: unknown[];
  bookings: unknown[];
  attributions: unknown[];
  notes: unknown[];
  limitations: string[];
}> {
  const contact = await prisma.contact.findFirst({
    where: {
      id: input.contactId,
      organisationId: input.organisationId,
      deletedAt: null,
    },
    include: {
      company: true,
      tags: { include: { tag: true } },
    },
  });
  if (!contact) throw new Error("Contact not found");

  const [leads, deals, activities, conversations, bookings, attributions, notes] =
    await Promise.all([
      prisma.lead.findMany({
        where: {
          organisationId: input.organisationId,
          contactId: contact.id,
          deletedAt: null,
        },
        include: { stage: true },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      prisma.deal.findMany({
        where: {
          organisationId: input.organisationId,
          contactId: contact.id,
          deletedAt: null,
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      prisma.crmActivity.findMany({
        where: { organisationId: input.organisationId, contactId: contact.id },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      prisma.conversation.findMany({
        where: {
          organisationId: input.organisationId,
          contactId: contact.id,
          deletedAt: null,
        },
        orderBy: { lastMessageAt: "desc" },
        take: 10,
        select: {
          id: true,
          subject: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          intent: true,
          sentiment: true,
        },
      }),
      prisma.booking.findMany({
        where: { organisationId: input.organisationId, contactId: contact.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.attribution.findMany({
        where: { organisationId: input.organisationId, contactId: contact.id },
        include: { campaign: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.note.findMany({
        where: { organisationId: input.organisationId, contactId: contact.id },
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { author: { select: { id: true, name: true, email: true } } },
      }),
    ]);

  return {
    contact,
    company: contact.company,
    leads,
    deals,
    activities,
    conversations,
    bookings,
    attributions,
    notes,
    limitations: [
      "Customer 360 only shows stored CRM evidence — no psychographic or sensitive inferences.",
      "Attribution rows include confidence and limitations when set; missing confidence means unknown.",
      "Lead and Deal may both exist for the same contact during migration.",
    ],
  };
}
