/**
 * Phase 8C.3 — seed TWO synthetic QA organisations for Operator testing (production DB).
 *
 * Usage:
 *   npx tsx scripts/qa-seed-phase8c3-orgs.ts
 *
 * Requires DATABASE_URL in .env; owner from E2E_EMAIL or E2E_ADMIN_EMAIL.
 * Safe: creates/refreshes only qa-8c3-rich and qa-8c3-sparse — never touches Shobhit Agency.
 */
import {
  PrismaClient,
  MemberRole,
  OrganisationStatus,
  DealStatus,
  GoalStatus,
  ContentPieceStatus,
  FollowUpStatus,
  QualificationStatus,
} from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const QA = "phase8c3";
const QA_META = { qa: QA, origin: "qa_seed_phase8c3" } as const;

const RICH_SLUG = "qa-8c3-rich";
const SPARSE_SLUG = "qa-8c3-sparse";
const RICH_NAME = "Meridian Ops QA Rich";
const SPARSE_NAME = "Meridian Ops QA Sparse";

const OWNER_EMAIL = (
  process.env.E2E_EMAIL ||
  process.env.E2E_ADMIN_EMAIL ||
  "shobhit2069@gmail.com"
)
  .toLowerCase()
  .trim();

const DEFAULT_PIPELINE_STAGES = [
  { name: "New", slug: "new", position: 0 },
  { name: "Contacted", slug: "contacted", position: 1 },
  { name: "Engaged", slug: "engaged", position: 2 },
  { name: "Qualifying", slug: "qualifying", position: 3 },
  { name: "Qualified", slug: "qualified", position: 4 },
  { name: "Booking Link Sent", slug: "booking_offered", position: 5 },
  { name: "Booked", slug: "booked", position: 6 },
  { name: "Won", slug: "won", position: 7, isWon: true },
  { name: "Disqualified", slug: "disqualified", position: 8, isLost: true },
];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function assertNotShobhit(name: string, slug: string): void {
  const haystack = `${name} ${slug}`.toLowerCase();
  if (haystack.includes("shobhit") && !haystack.includes("qa")) {
    throw new Error(`Refusing to touch non-QA Shobhit org: ${name} (${slug})`);
  }
}

async function findOwner() {
  const user = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!user) {
    throw new Error(`No user with email ${OWNER_EMAIL}. Create the account first.`);
  }
  return user;
}

async function ensureMembership(orgId: string, userId: string): Promise<void> {
  await prisma.organisationMember.upsert({
    where: { organisationId_userId: { organisationId: orgId, userId } },
    update: { role: MemberRole.OWNER },
    create: { organisationId: orgId, userId, role: MemberRole.OWNER },
  });
}

async function ensureOrg(input: {
  name: string;
  slug: string;
  rich: boolean;
}): Promise<{ id: string; slug: string }> {
  assertNotShobhit(input.name, input.slug);

  let org = await prisma.organisation.findUnique({ where: { slug: input.slug } });
  if (org) {
    org = await prisma.organisation.update({
      where: { id: org.id },
      data: {
        name: input.name,
        deletedAt: null,
        status: OrganisationStatus.ACTIVE,
        demoData: false,
        isPlatform: false,
        timezone: "Europe/London",
        ...(input.rich ? { industryTemplateKey: "agency" } : {}),
      },
    });
  } else {
    org = await prisma.organisation.create({
      data: {
        name: input.name,
        slug: input.slug,
        timezone: "Europe/London",
        status: OrganisationStatus.ACTIVE,
        demoData: false,
        isPlatform: false,
        autopilotMode: "OFF",
        ...(input.rich ? { industryTemplateKey: "agency" } : {}),
      },
    });
  }

  return { id: org.id, slug: org.slug };
}

async function ensureDefaultPipeline(orgId: string) {
  let pipeline = await prisma.pipeline.findFirst({
    where: { organisationId: orgId, isDefault: true },
    include: { stages: { orderBy: { position: "asc" } } },
  });

  if (!pipeline) {
    pipeline = await prisma.pipeline.create({
      data: {
        organisationId: orgId,
        name: "Default",
        isDefault: true,
        stages: { create: DEFAULT_PIPELINE_STAGES },
      },
      include: { stages: { orderBy: { position: "asc" } } },
    });
  } else if (pipeline.stages.length === 0) {
    await prisma.pipelineStage.createMany({
      data: DEFAULT_PIPELINE_STAGES.map((stage) => ({
        ...stage,
        pipelineId: pipeline!.id,
      })),
    });
    pipeline = await prisma.pipeline.findFirstOrThrow({
      where: { id: pipeline.id },
      include: { stages: { orderBy: { position: "asc" } } },
    });
  }

  return pipeline;
}

async function ensureAgentConfig(orgId: string): Promise<void> {
  const existing = await prisma.agentConfiguration.findFirst({
    where: { organisationId: orgId },
  });
  if (!existing) {
    await prisma.agentConfiguration.create({
      data: {
        organisationId: orgId,
        name: "Default Agent",
        isActive: true,
        isDraft: false,
      },
    });
  }
}

async function countOrgEntities(orgId: string) {
  const [
    companies,
    contacts,
    deals,
    leads,
    conversations,
    followUps,
    goals,
    contentPieces,
    businessOpportunities,
    automationRules,
    automationOpportunities,
    pipelines,
  ] = await Promise.all([
    prisma.company.count({ where: { organisationId: orgId, deletedAt: null } }),
    prisma.contact.count({ where: { organisationId: orgId, deletedAt: null } }),
    prisma.deal.count({ where: { organisationId: orgId, deletedAt: null } }),
    prisma.lead.count({ where: { organisationId: orgId, deletedAt: null } }),
    prisma.conversation.count({ where: { organisationId: orgId, deletedAt: null } }),
    prisma.followUp.count({ where: { organisationId: orgId } }),
    prisma.goal.count({ where: { organisationId: orgId } }),
    prisma.contentPiece.count({ where: { organisationId: orgId } }),
    prisma.businessOpportunity.count({ where: { organisationId: orgId } }),
    prisma.automationRule.count({ where: { organisationId: orgId } }),
    prisma.automationOpportunity.count({ where: { organisationId: orgId } }),
    prisma.pipeline.count({ where: { organisationId: orgId } }),
  ]);

  return {
    companies,
    contacts,
    deals,
    leads,
    conversations,
    followUps,
    goals,
    contentPieces,
    businessOpportunities,
    automationRules,
    automationOpportunities,
    pipelines,
  };
}

async function upsertCompany(
  orgId: string,
  spec: { name: string; domain: string; industry: string },
) {
  const existing = await prisma.company.findFirst({
    where: { organisationId: orgId, name: spec.name, deletedAt: null },
  });
  if (existing) {
    return prisma.company.update({
      where: { id: existing.id },
      data: {
        domain: spec.domain,
        industry: spec.industry,
        metadata: QA_META,
      },
    });
  }
  return prisma.company.create({
    data: {
      organisationId: orgId,
      name: spec.name,
      domain: spec.domain,
      industry: spec.industry,
      metadata: QA_META,
    },
  });
}

async function upsertContact(
  orgId: string,
  spec: {
    key: string;
    fullName: string;
    email?: string;
    companyId?: string;
  },
) {
  const instagramUsername = `p8c3_${spec.key}`;
  const existing = await prisma.contact.findFirst({
    where: { organisationId: orgId, instagramUsername, deletedAt: null },
  });
  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: {
        fullName: spec.fullName,
        email: spec.email,
        companyId: spec.companyId,
        leadSource: QA,
        metadata: QA_META,
      },
    });
  }
  return prisma.contact.create({
    data: {
      organisationId: orgId,
      fullName: spec.fullName,
      instagramUsername,
      email: spec.email,
      companyId: spec.companyId,
      leadSource: QA,
      campaignSource: QA,
      metadata: QA_META,
    },
  });
}

async function upsertDeal(
  orgId: string,
  spec: {
    name: string;
    amountCents: number;
    stageLabel: string;
    companyId?: string;
    contactId?: string;
    staleDaysAgo?: number;
  },
) {
  const existing = await prisma.deal.findFirst({
    where: { organisationId: orgId, name: spec.name, deletedAt: null },
  });
  const deal =
    existing ??
    (await prisma.deal.create({
      data: {
        organisationId: orgId,
        name: spec.name,
        amountCents: spec.amountCents,
        currency: "GBP",
        status: DealStatus.OPEN,
        stageLabel: spec.stageLabel,
        companyId: spec.companyId,
        contactId: spec.contactId,
        summary: "Professional services opportunity seeded for Operator QA.",
        metadata: QA_META,
      },
    }));

  if (existing) {
    await prisma.deal.update({
      where: { id: deal.id },
      data: {
        amountCents: spec.amountCents,
        currency: "GBP",
        status: DealStatus.OPEN,
        stageLabel: spec.stageLabel,
        companyId: spec.companyId,
        contactId: spec.contactId,
        metadata: QA_META,
      },
    });
  }

  if (spec.staleDaysAgo != null) {
    const oldDate = daysAgo(spec.staleDaysAgo);
    await prisma.$executeRaw`UPDATE "Deal" SET "updatedAt" = ${oldDate} WHERE id = ${deal.id}`;
  }

  return deal;
}

async function upsertConversation(
  orgId: string,
  spec: {
    key: string;
    contactId: string;
    unreadCount: number;
    needsHumanReview: boolean;
    handoffReason?: string;
    handlingMode: "AI" | "HUMAN" | "PAUSED";
    lastMessageAt: Date;
  },
) {
  const externalThreadId = `p8c3_thread_${spec.key}`;
  const existing = await prisma.conversation.findFirst({
    where: { organisationId: orgId, externalThreadId },
  });
  const data = {
    contactId: spec.contactId,
    handlingMode: spec.handlingMode,
    unreadCount: spec.unreadCount,
    needsHumanReview: spec.needsHumanReview,
    handoffReason: spec.handoffReason ?? null,
    aiPaused: spec.handlingMode !== "AI",
    lastMessageAt: spec.lastMessageAt,
    lastMessagePreview: "Latest message in seeded QA thread.",
    lastInboundAt: spec.lastMessageAt,
    summary: "Seeded conversation for Phase 8C.3 Operator testing.",
    metadata: QA_META,
  };

  if (existing) {
    return prisma.conversation.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.conversation.create({
    data: {
      organisationId: orgId,
      externalThreadId,
      ...data,
    },
  });
}

async function upsertLead(
  orgId: string,
  spec: {
    contactId: string;
    conversationId?: string;
    pipelineId: string;
    stageSlug: string;
    score: number;
    qualificationStatus: QualificationStatus;
    stages: Array<{ id: string; slug: string }>;
  },
) {
  const stage = spec.stages.find((s) => s.slug === spec.stageSlug) ?? spec.stages[0]!;
  const existing = await prisma.lead.findFirst({
    where: { organisationId: orgId, contactId: spec.contactId, deletedAt: null },
  });
  if (existing) {
    return prisma.lead.update({
      where: { id: existing.id },
      data: {
        conversationId: spec.conversationId,
        pipelineId: spec.pipelineId,
        stageId: stage.id,
        score: spec.score,
        qualificationStatus: spec.qualificationStatus,
        scoreExplanation: "Seeded lead score for Operator QA.",
        metadata: QA_META,
      },
    });
  }
  return prisma.lead.create({
    data: {
      organisationId: orgId,
      contactId: spec.contactId,
      conversationId: spec.conversationId,
      pipelineId: spec.pipelineId,
      stageId: stage.id,
      score: spec.score,
      qualificationStatus: spec.qualificationStatus,
      scoreExplanation: "Seeded lead score for Operator QA.",
      metadata: QA_META,
    },
  });
}

async function upsertFollowUp(
  orgId: string,
  spec: {
    key: string;
    contactId: string;
    conversationId?: string;
    leadId?: string;
    overdueDays: number;
  },
) {
  const marker = `${QA}:followup:${spec.key}`;
  const existing = await prisma.followUp.findFirst({
    where: {
      organisationId: orgId,
      contactId: spec.contactId,
      messageBody: marker,
    },
  });
  const scheduledFor = daysAgo(spec.overdueDays);
  if (existing) {
    return prisma.followUp.update({
      where: { id: existing.id },
      data: {
        status: FollowUpStatus.SCHEDULED,
        scheduledFor,
        conversationId: spec.conversationId,
        leadId: spec.leadId,
      },
    });
  }
  return prisma.followUp.create({
    data: {
      organisationId: orgId,
      contactId: spec.contactId,
      conversationId: spec.conversationId,
      leadId: spec.leadId,
      status: FollowUpStatus.SCHEDULED,
      scheduledFor,
      attemptNumber: 1,
      messageBody: marker,
    },
  });
}

async function upsertGoal(
  orgId: string,
  spec: { name: string; status: GoalStatus; description: string },
) {
  const existing = await prisma.goal.findFirst({
    where: { organisationId: orgId, name: spec.name },
  });
  if (existing) {
    return prisma.goal.update({
      where: { id: existing.id },
      data: {
        status: spec.status,
        description: spec.description,
        source: QA,
        category: "REVENUE",
      },
    });
  }
  return prisma.goal.create({
    data: {
      organisationId: orgId,
      name: spec.name,
      description: spec.description,
      status: spec.status,
      source: QA,
      category: "REVENUE",
      priority: 50,
    },
  });
}

async function upsertContentPiece(
  orgId: string,
  spec: { title: string; status: ContentPieceStatus; platform: string },
) {
  const existing = await prisma.contentPiece.findFirst({
    where: { organisationId: orgId, title: spec.title },
  });
  if (existing) {
    return prisma.contentPiece.update({
      where: { id: existing.id },
      data: {
        status: spec.status,
        platform: spec.platform,
        body: "Seeded content body for Phase 8C.3 Operator testing.",
        whyEvidence: QA_META,
      },
    });
  }
  return prisma.contentPiece.create({
    data: {
      organisationId: orgId,
      title: spec.title,
      body: "Seeded content body for Phase 8C.3 Operator testing.",
      status: spec.status,
      platform: spec.platform,
      whyEvidence: QA_META,
    },
  });
}

async function upsertBusinessOpportunity(
  orgId: string,
  spec: {
    dedupeKey: string;
    type: "DEAL_RISK" | "REACTIVATION";
    title: string;
    summary: string;
    goalId?: string;
  },
) {
  const existing = await prisma.businessOpportunity.findUnique({
    where: { organisationId_dedupeKey: { organisationId: orgId, dedupeKey: spec.dedupeKey } },
  });
  if (existing) {
    return prisma.businessOpportunity.update({
      where: { id: existing.id },
      data: {
        type: spec.type,
        title: spec.title,
        summary: spec.summary,
        status: "DETECTED",
        source: QA,
        goalId: spec.goalId,
        qualityGateStatus: "PASSED",
        priorityScore: spec.type === "DEAL_RISK" ? 82 : 58,
      },
    });
  }
  const created = await prisma.businessOpportunity.create({
    data: {
      organisationId: orgId,
      type: spec.type,
      title: spec.title,
      summary: spec.summary,
      status: "DETECTED",
      impact: spec.type === "DEAL_RISK" ? "HIGH" : "MEDIUM",
      urgency: spec.type === "DEAL_RISK" ? "HIGH" : "LOW",
      confidence: "MEDIUM",
      priorityScore: spec.type === "DEAL_RISK" ? 82 : 58,
      source: QA,
      dedupeKey: spec.dedupeKey,
      goalId: spec.goalId,
      qualityGateStatus: "PASSED",
    },
  });
  await prisma.opportunityEvidence.create({
    data: {
      organisationId: orgId,
      opportunityId: created.id,
      evidenceType: "observation",
      label: "QA seed evidence",
      detail: "Seeded for Phase 8C.3 Operator testing.",
    },
  });
  return created;
}

async function seedSparseOrg(orgId: string, userId: string): Promise<void> {
  await ensureMembership(orgId, userId);
  await ensureDefaultPipeline(orgId);
  await ensureAgentConfig(orgId);
}

async function seedRichOrg(orgId: string, userId: string): Promise<void> {
  await ensureMembership(orgId, userId);
  const pipeline = await ensureDefaultPipeline(orgId);
  await ensureAgentConfig(orgId);
  const stages = pipeline.stages;

  await prisma.organisation.update({
    where: { id: orgId },
    data: { industryTemplateKey: "agency", name: RICH_NAME },
  });

  await prisma.organisationPreference.upsert({
    where: { organisationId_key: { organisationId: orgId, key: "business_profile" } },
    update: {
      value: {
        industry: "Professional services",
        region: "United Kingdom",
        companyName: RICH_NAME,
        ...QA_META,
      },
    },
    create: {
      organisationId: orgId,
      key: "business_profile",
      value: {
        industry: "Professional services",
        region: "United Kingdom",
        companyName: RICH_NAME,
        ...QA_META,
      },
    },
  });

  const existingClaim = await prisma.businessClaim.findFirst({
    where: {
      organisationId: orgId,
      subjectType: "organisation",
      subjectId: orgId,
      predicate: "industry",
    },
  });
  if (existingClaim) {
    await prisma.businessClaim.update({
      where: { id: existingClaim.id },
      data: {
        valueText: "UK professional services",
        source: QA,
        status: "CONFIRMED",
      },
    });
  } else {
    await prisma.businessClaim.create({
      data: {
        organisationId: orgId,
        subjectType: "organisation",
        subjectId: orgId,
        predicate: "industry",
        valueText: "UK professional services",
        source: QA,
        status: "CONFIRMED",
      },
    });
  }

  const productName = "Meridian Ops advisory retainer";
  const existingProduct = await prisma.productOffering.findFirst({
    where: { organisationId: orgId, name: productName },
  });
  if (existingProduct) {
    await prisma.productOffering.update({
      where: { id: existingProduct.id },
      data: {
        description: "CRM, inbox automation, and pipeline management for UK SMEs.",
        category: "Professional services",
        currency: "GBP",
        status: "ACTIVE",
        metadata: QA_META,
      },
    });
  } else {
    await prisma.productOffering.create({
      data: {
        organisationId: orgId,
        name: productName,
        description: "CRM, inbox automation, and pipeline management for UK SMEs.",
        category: "Professional services",
        currency: "GBP",
        status: "ACTIVE",
        metadata: QA_META,
      },
    });
  }

  const audienceName = "UK agency founders";
  const existingAudience = await prisma.audienceSegment.findFirst({
    where: { organisationId: orgId, name: audienceName },
  });
  if (existingAudience) {
    await prisma.audienceSegment.update({
      where: { id: existingAudience.id },
      data: {
        description: "Founder-led service businesses booking demos from social channels.",
        evidenceNote: QA,
      },
    });
  } else {
    await prisma.audienceSegment.create({
      data: {
        organisationId: orgId,
        name: audienceName,
        description: "Founder-led service businesses booking demos from social channels.",
        evidenceNote: QA,
      },
    });
  }

  const companySpecs = [
    {
      name: "Hartley & Partners LLP",
      domain: "hartley-partners.co.uk",
      industry: "Professional services",
    },
    {
      name: "CloudLedger SaaS Ltd",
      domain: "cloudledger.io",
      industry: "SaaS",
    },
    {
      name: "Meridian Freight UK",
      domain: "meridianfreight.co.uk",
      industry: "Logistics",
    },
    {
      name: "TalentBridge Recruitments",
      domain: "talentbridge.co.uk",
      industry: "Recruitment",
    },
    {
      name: "Ashford Grove Accountants",
      domain: "ashfordgrove.co.uk",
      industry: "Accountancy",
    },
    {
      name: "Northgate Advisory Group",
      domain: "northgate-advisory.co.uk",
      industry: "Professional services",
    },
    {
      name: "Prism HR Solutions",
      domain: "prismhr.co.uk",
      industry: "Professional services",
    },
    {
      name: "Cobalt Systems Integrators",
      domain: "cobaltsystems.co.uk",
      industry: "SaaS",
    },
  ];

  const companies = [];
  for (const spec of companySpecs) {
    companies.push(await upsertCompany(orgId, spec));
  }

  const contactSpecs = [
    { key: "c01", fullName: "James Hartley", email: "j.hartley@hartley-partners.co.uk", companyIdx: 0 },
    { key: "c02", fullName: "Sophie Mitchell", email: "s.mitchell@cloudledger.io", companyIdx: 1 },
    { key: "c03", fullName: "Marcus Okafor", email: "marcus@talentbridge.co.uk", companyIdx: 3 },
    { key: "c04", fullName: "Priya Nandakumar", email: "priya@northgate-advisory.co.uk", companyIdx: 5 },
    { key: "c05", fullName: "Elena Rossi", email: "elena.rossi@ashfordgrove.co.uk", companyIdx: 4 },
    { key: "c06", fullName: "Wei Zhang", email: "wei.zhang@cobaltsystems.co.uk", companyIdx: 7 },
    { key: "c07", fullName: "Amara Osei", email: "amara.osei@meridianfreight.co.uk", companyIdx: 2 },
    { key: "c08", fullName: "Fatima Hassan", email: "fatima@prismhr.co.uk", companyIdx: 6 },
    { key: "c09", fullName: "Oliver Bennett", email: "oliver.bennett@hartley-partners.co.uk", companyIdx: 0 },
    { key: "c10", fullName: "Yuki Tanaka", email: "y.tanaka@cloudledger.io", companyIdx: 1 },
    { key: "c11", fullName: "Carlos Mendez", email: "carlos@talentbridge.co.uk", companyIdx: 3 },
    { key: "c12", fullName: "Aisha Patel", email: "aisha.patel@northgate-advisory.co.uk", companyIdx: 5 },
    { key: "c13", fullName: "Liam Murphy", email: "liam.murphy@ashfordgrove.co.uk", companyIdx: 4 },
    { key: "c14", fullName: "Grace Okonkwo", email: "grace@cobaltsystems.co.uk", companyIdx: 7 },
    { key: "c15", fullName: "Noah Sullivan", email: "noah@meridianfreight.co.uk", companyIdx: 2 },
    { key: "c16", fullName: "Meera Krishnan", email: "meera@prismhr.co.uk", companyIdx: 6 },
    { key: "c17", fullName: "Daniel Kowalski", email: "daniel.k@hartley-partners.co.uk", companyIdx: 0 },
    { key: "c18", fullName: "Hannah Clarke", email: "h.clarke@cloudledger.io", companyIdx: 1 },
    { key: "c19", fullName: "Raj Mehta", email: "raj.mehta@talentbridge.co.uk", companyIdx: 3 },
    { key: "c20", fullName: "Isabel Ferreira", email: "isabel@northgate-advisory.co.uk", companyIdx: 5 },
  ];

  const contacts = [];
  for (const spec of contactSpecs) {
    contacts.push(
      await upsertContact(orgId, {
        key: spec.key,
        fullName: spec.fullName,
        email: spec.email,
        companyId: companies[spec.companyIdx]?.id,
      }),
    );
  }

  const dealSpecs = [
    {
      name: "CloudLedger annual platform renewal",
      amountCents: 4_500_000,
      stageLabel: "Discovery",
      companyIdx: 1,
      contactIdx: 1,
    },
    {
      name: "Hartley CRM automation rollout",
      amountCents: 2_850_000,
      stageLabel: "Proposal",
      companyIdx: 0,
      contactIdx: 0,
      staleDaysAgo: 28,
    },
    {
      name: "TalentBridge inbox pilot",
      amountCents: 1_200_000,
      stageLabel: "Negotiation",
      companyIdx: 3,
      contactIdx: 2,
    },
    {
      name: "Ashford Grove compliance workflow",
      amountCents: 1_875_000,
      stageLabel: "Verbal yes",
      companyIdx: 4,
      contactIdx: 4,
    },
    {
      name: "Northgate advisory retainer",
      amountCents: 9_600_000,
      stageLabel: "Discovery",
      companyIdx: 5,
      contactIdx: 3,
      staleDaysAgo: 35,
    },
    {
      name: "Prism HR onboarding package",
      amountCents: 3_420_000,
      stageLabel: "Proposal",
      companyIdx: 6,
      contactIdx: 7,
    },
    {
      name: "Cobalt integrations phase two",
      amountCents: 5_280_000,
      stageLabel: "Negotiation",
      companyIdx: 7,
      contactIdx: 5,
      staleDaysAgo: 22,
    },
    {
      name: "Meridian Freight partner portal",
      amountCents: 2_240_000,
      stageLabel: "Discovery",
      companyIdx: 2,
      contactIdx: 6,
    },
  ];

  for (const spec of dealSpecs) {
    await upsertDeal(orgId, {
      name: spec.name,
      amountCents: spec.amountCents,
      stageLabel: spec.stageLabel,
      companyId: companies[spec.companyIdx]?.id,
      contactId: contacts[spec.contactIdx]?.id,
      staleDaysAgo: spec.staleDaysAgo,
    });
  }

  const convReview = await upsertConversation(orgId, {
    key: "needs_review",
    contactId: contacts[2]!.id,
    unreadCount: 2,
    needsHumanReview: true,
    handlingMode: "AI",
    lastMessageAt: daysAgo(1),
  });

  const convHandoff = await upsertConversation(orgId, {
    key: "handoff",
    contactId: contacts[3]!.id,
    unreadCount: 3,
    needsHumanReview: true,
    handoffReason: "Contact requested a human review of contract terms.",
    handlingMode: "HUMAN",
    lastMessageAt: daysAgo(0),
  });

  const convQuiet1 = await upsertConversation(orgId, {
    key: "quiet_a",
    contactId: contacts[8]!.id,
    unreadCount: 0,
    needsHumanReview: false,
    handlingMode: "AI",
    lastMessageAt: daysAgo(6),
  });

  const convQuiet2 = await upsertConversation(orgId, {
    key: "quiet_b",
    contactId: contacts[9]!.id,
    unreadCount: 0,
    needsHumanReview: false,
    handlingMode: "AI",
    lastMessageAt: daysAgo(11),
  });

  const strongLead1 = await upsertLead(orgId, {
    contactId: contacts[2]!.id,
    conversationId: convReview.id,
    pipelineId: pipeline.id,
    stageSlug: "qualified",
    score: 84,
    qualificationStatus: QualificationStatus.QUALIFIED,
    stages,
  });

  const strongLead2 = await upsertLead(orgId, {
    contactId: contacts[3]!.id,
    conversationId: convHandoff.id,
    pipelineId: pipeline.id,
    stageSlug: "booking_offered",
    score: 78,
    qualificationStatus: QualificationStatus.QUALIFIED,
    stages,
  });

  const weakLead1 = await upsertLead(orgId, {
    contactId: contacts[14]!.id,
    conversationId: convQuiet1.id,
    pipelineId: pipeline.id,
    stageSlug: "contacted",
    score: 12,
    qualificationStatus: QualificationStatus.UNKNOWN,
    stages,
  });

  const weakLead2 = await upsertLead(orgId, {
    contactId: contacts[15]!.id,
    conversationId: convQuiet2.id,
    pipelineId: pipeline.id,
    stageSlug: "new",
    score: 8,
    qualificationStatus: QualificationStatus.UNKNOWN,
    stages,
  });

  await upsertFollowUp(orgId, {
    key: "overdue_1",
    contactId: contacts[2]!.id,
    conversationId: convReview.id,
    leadId: strongLead1.id,
    overdueDays: 4,
  });
  await upsertFollowUp(orgId, {
    key: "overdue_2",
    contactId: contacts[3]!.id,
    conversationId: convHandoff.id,
    leadId: strongLead2.id,
    overdueDays: 6,
  });
  await upsertFollowUp(orgId, {
    key: "overdue_3",
    contactId: contacts[14]!.id,
    conversationId: convQuiet1.id,
    leadId: weakLead1.id,
    overdueDays: 2,
  });

  const atRiskGoal = await upsertGoal(orgId, {
    name: "Q3 pipeline coverage",
    status: GoalStatus.AT_RISK,
    description: "Maintain enough qualified pipeline to hit quarterly revenue targets.",
  });
  await upsertGoal(orgId, {
    name: "Qualified meeting rate",
    status: GoalStatus.ACTIVE,
    description: "Improve conversion from first reply to booked discovery call.",
  });
  await upsertGoal(orgId, {
    name: "LinkedIn content cadence",
    status: GoalStatus.ACTIVE,
    description: "Publish two thought-leadership posts per week for advisory prospects.",
  });

  await upsertContentPiece(orgId, {
    title: "Client onboarding checklist carousel",
    status: ContentPieceStatus.IN_REVIEW,
    platform: "linkedin",
  });
  await upsertContentPiece(orgId, {
    title: "Why response time shapes trust in advisory sales",
    status: ContentPieceStatus.APPROVED,
    platform: "instagram",
  });

  await upsertBusinessOpportunity(orgId, {
    dedupeKey: `${QA}:deal_risk_stale_proposals`,
    type: "DEAL_RISK",
    title: "Proposal-stage deals without recent activity",
    summary:
      "Several open proposals have not moved in three weeks. A coordinated follow-up may prevent slip into next quarter.",
    goalId: atRiskGoal.id,
  });
  await upsertBusinessOpportunity(orgId, {
    dedupeKey: `${QA}:reactivation_quiet_threads`,
    type: "REACTIVATION",
    title: "Re-engage quiet inbound threads from last week",
    summary:
      "A handful of contacts acknowledged initial outreach but have not replied since. A light check-in may reopen the conversation.",
    goalId: atRiskGoal.id,
  });

  const ruleName = "Notify owner when qualified lead waits 24h";
  const existingRule = await prisma.automationRule.findFirst({
    where: { organisationId: orgId, name: ruleName },
  });
  if (existingRule) {
    await prisma.automationRule.update({
      where: { id: existingRule.id },
      data: {
        description: "Seeded automation rule for Operator QA.",
        triggerType: "lead_score_changed",
        isActive: true,
        conditions: { minScore: 70, ...QA_META },
        actions: [{ type: "notify_owner", ...QA_META }],
        workflow: { steps: ["score_threshold", "notify"], ...QA_META },
      },
    });
  } else {
    await prisma.automationRule.create({
      data: {
        organisationId: orgId,
        name: ruleName,
        description: "Seeded automation rule for Operator QA.",
        triggerType: "lead_score_changed",
        isActive: true,
        conditions: { minScore: 70, ...QA_META },
        actions: [{ type: "notify_owner", ...QA_META }],
        workflow: { steps: ["score_threshold", "notify"], ...QA_META },
      },
    });
  }

  const autoOppProcessKey = `${QA}:proposal_to_negotiation`;
  const existingAutoOpp = await prisma.automationOpportunity.findFirst({
    where: { organisationId: orgId, processKey: autoOppProcessKey },
  });
  if (existingAutoOpp) {
    await prisma.automationOpportunity.update({
      where: { id: existingAutoOpp.id },
      data: {
        fromStage: "Proposal",
        toStage: "Negotiation",
        title: "Standardise proposal follow-up sequence",
        volume: 14,
        stabilityScore: 0.72,
        delayMs: 1_728_000_000,
        metadata: QA_META,
      },
    });
  } else {
    await prisma.automationOpportunity.create({
      data: {
        organisationId: orgId,
        processKey: autoOppProcessKey,
        fromStage: "Proposal",
        toStage: "Negotiation",
        title: "Standardise proposal follow-up sequence",
        volume: 14,
        stabilityScore: 0.72,
        delayMs: 1_728_000_000,
        metadata: QA_META,
      },
    });
  }

}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in .env");
  }

  const shobhitOrgs = await prisma.organisation.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: "Shobhit Agency", mode: "insensitive" } },
        {
          AND: [
            { slug: { contains: "shobhit", mode: "insensitive" } },
            { slug: { notIn: [RICH_SLUG, SPARSE_SLUG] } },
          ],
        },
      ],
    },
    select: { id: true, name: true, slug: true },
  });
  if (shobhitOrgs.length > 0) {
    console.log(
      `Safety check: found ${shobhitOrgs.length} Shobhit org(s) — will not modify them.`,
    );
  }

  const owner = await findOwner();

  const richOrg = await ensureOrg({ name: RICH_NAME, slug: RICH_SLUG, rich: true });
  const sparseOrg = await ensureOrg({ name: SPARSE_NAME, slug: SPARSE_SLUG, rich: false });

  await seedRichOrg(richOrg.id, owner.id);
  await seedSparseOrg(sparseOrg.id, owner.id);

  const DATA_RICH_COUNTS = await countOrgEntities(richOrg.id);
  const SPARSE_COUNTS = await countOrgEntities(sparseOrg.id);

  console.log(
    JSON.stringify(
      {
        DATA_RICH_ORG_ID: richOrg.id,
        SPARSE_ORG_ID: sparseOrg.id,
        DATA_RICH_COUNTS,
        SPARSE_COUNTS,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
