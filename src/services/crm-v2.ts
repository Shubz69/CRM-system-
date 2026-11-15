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
    // A deleted company may still hold this exact name (unique per workspace).
    await freeCompanyNameFromDeletedRows(tx, input.organisationId, name);
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

/** A deal may only link to records in its own workspace (never another tenant's ids). */
export class DealLinkError extends Error {}

export async function assertDealLinksInOrganisation(input: {
  organisationId: string;
  companyId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
}): Promise<void> {
  const { organisationId } = input;
  const [company, contact, lead] = await Promise.all([
    input.companyId
      ? prisma.company.findFirst({
          where: { id: input.companyId, organisationId, deletedAt: null },
          select: { id: true },
        })
      : null,
    input.contactId
      ? prisma.contact.findFirst({
          where: { id: input.contactId, organisationId, deletedAt: null },
          select: { id: true },
        })
      : null,
    input.leadId
      ? prisma.lead.findFirst({
          where: { id: input.leadId, organisationId, deletedAt: null },
          select: { id: true },
        })
      : null,
  ]);
  if (input.companyId && !company) throw new DealLinkError("Company not found in this workspace.");
  if (input.contactId && !contact) throw new DealLinkError("Contact not found in this workspace.");
  if (input.leadId && !lead) throw new DealLinkError("Lead not found in this workspace.");
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
  await assertDealLinksInOrganisation(input);
  // No more hard-wired USD: an explicit currency wins, else the workspace's usual one (else GBP).
  const currency =
    normaliseDealCurrency(input.currency) ?? (await getDefaultDealCurrency(input.organisationId));
  const row = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        organisationId: input.organisationId,
        name: input.name.trim(),
        companyId: input.companyId || null,
        contactId: input.contactId || null,
        leadId: input.leadId || null,
        amountCents: input.amountCents ?? null,
        currency,
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

/** Currencies offered in the deal picker (any ISO 4217 code is accepted by the API). */
export const DEAL_CURRENCIES = ["GBP", "EUR", "USD", "AUD", "CAD", "NZD", "CHF", "AED", "INR", "SGD", "ZAR"] as const;
export const FALLBACK_DEAL_CURRENCY = "GBP";

/** Every ISO 4217 code the runtime knows, or null where Intl can't list them. */
const ISO_CURRENCY_CODES: ReadonlySet<string> | null = (() => {
  try {
    return new Set(Intl.supportedValuesOf("currency"));
  } catch {
    return null;
  }
})();

/** Upper-case ISO 4217 code, or null when the value isn't a real currency (e.g. "ABC"). */
export function normaliseDealCurrency(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (ISO_CURRENCY_CODES && !ISO_CURRENCY_CODES.has(code)) return null;
  return code;
}

/**
 * The currency new deals start in: the one this workspace already uses most, else GBP
 * (deals used to be hard-wired to USD, so the old schema default is not a signal on its own).
 */
export async function getDefaultDealCurrency(organisationId: string): Promise<string> {
  try {
    const rows = await prisma.deal.groupBy({
      by: ["currency"],
      where: { organisationId, deletedAt: null },
      _count: { _all: true },
    });
    let best: { currency: string; count: number } | null = null;
    for (const row of rows) {
      const currency = normaliseDealCurrency(row.currency);
      if (!currency) continue;
      const count = row._count._all;
      if (!best || count > best.count || (count === best.count && currency === FALLBACK_DEAL_CURRENCY)) {
        best = { currency, count };
      }
    }
    return best?.currency ?? FALLBACK_DEAL_CURRENCY;
  } catch {
    return FALLBACK_DEAL_CURRENCY;
  }
}

/** A company edit that would collide with another live company's name. */
export class CompanyConflictError extends Error {}

/**
 * Company names are unique per workspace in the database, including soft-deleted rows. When a
 * deleted company still holds the exact name someone wants to use, rename that deleted row out
 * of the way (its original name stays in metadata) so the live company can take it.
 */
async function freeCompanyNameFromDeletedRows(
  tx: Prisma.TransactionClient,
  organisationId: string,
  name: string,
): Promise<void> {
  const holder = await tx.company.findFirst({
    where: { organisationId, name, deletedAt: { not: null } },
    select: { id: true, metadata: true },
  });
  if (!holder) return;
  const metadata =
    holder.metadata && typeof holder.metadata === "object" && !Array.isArray(holder.metadata)
      ? (holder.metadata as Record<string, unknown>)
      : {};
  await tx.company.update({
    where: { id: holder.id },
    data: {
      name: `${name.slice(0, 160)} (deleted ${holder.id.slice(-6)})`,
      metadata: { ...metadata, deletedName: name } as Prisma.InputJsonValue,
    },
  });
}

export async function updateCompany(input: {
  organisationId: string;
  companyId: string;
  name?: string;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeBand?: string | null;
}): Promise<{ id: string; changed: Record<string, { from: unknown; to: unknown }> }> {
  const existing = await prisma.company.findFirst({
    where: { id: input.companyId, organisationId: input.organisationId, deletedAt: null },
  });
  if (!existing) throw new DealLinkError("Company not found in this workspace.");

  const name = input.name === undefined ? undefined : input.name.trim();
  if (name !== undefined && !name) throw new CompanyConflictError("Company name is required.");
  if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await prisma.company.findFirst({
      where: {
        organisationId: input.organisationId,
        name: { equals: name, mode: "insensitive" },
        deletedAt: null,
        NOT: { id: existing.id },
      },
      select: { id: true },
    });
    if (clash) throw new CompanyConflictError(`A company called "${name}" already exists.`);
  }

  const next = {
    name: name ?? existing.name,
    domain: input.domain === undefined ? existing.domain : input.domain?.trim() || null,
    website: input.website === undefined ? existing.website : input.website?.trim() || null,
    industry: input.industry === undefined ? existing.industry : input.industry?.trim() || null,
    sizeBand: input.sizeBand === undefined ? existing.sizeBand : input.sizeBand?.trim() || null,
  };
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (next[key] !== existing[key]) changed[key] = { from: existing[key], to: next[key] };
  }
  if (Object.keys(changed).length === 0) return { id: existing.id, changed };

  await prisma.$transaction(async (tx) => {
    if (changed.name) await freeCompanyNameFromDeletedRows(tx, input.organisationId, next.name);
    await tx.company.update({ where: { id: existing.id }, data: next });
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
  return { id: existing.id, changed };
}

/**
 * Soft-delete a company. Its deals and contacts stay (they keep working) but are unlinked so no
 * list shows a deleted account; the unlinked ids are kept in the company's metadata.
 */
export async function softDeleteCompany(input: {
  organisationId: string;
  companyId: string;
}): Promise<{ id: string; name: string; unlinkedDealIds: string[]; unlinkedContactIds: string[] }> {
  const existing = await prisma.company.findFirst({
    where: { id: input.companyId, organisationId: input.organisationId, deletedAt: null },
  });
  if (!existing) throw new DealLinkError("Company not found in this workspace.");

  return prisma.$transaction(async (tx) => {
    const [deals, contacts] = await Promise.all([
      tx.deal.findMany({
        where: { organisationId: input.organisationId, companyId: existing.id },
        select: { id: true },
      }),
      tx.contact.findMany({
        where: { organisationId: input.organisationId, companyId: existing.id },
        select: { id: true },
      }),
    ]);
    const unlinkedDealIds = deals.map((d) => d.id);
    const unlinkedContactIds = contacts.map((c) => c.id);
    if (unlinkedDealIds.length) {
      await tx.deal.updateMany({
        where: { organisationId: input.organisationId, id: { in: unlinkedDealIds } },
        data: { companyId: null },
      });
    }
    if (unlinkedContactIds.length) {
      await tx.contact.updateMany({
        where: { organisationId: input.organisationId, id: { in: unlinkedContactIds } },
        data: { companyId: null },
      });
    }
    const metadata =
      existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    await tx.company.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        metadata: {
          ...metadata,
          deletedUnlinked: { dealIds: unlinkedDealIds, contactIds: unlinkedContactIds },
        } as Prisma.InputJsonValue,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "COMPANY_UPDATED",
      aggregateType: "Company",
      aggregateId: existing.id,
      payload: { companyId: existing.id },
      dedupeKey: `COMPANY_UPDATED:${existing.id}:deleted`,
    });
    return { id: existing.id, name: existing.name, unlinkedDealIds, unlinkedContactIds };
  });
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
