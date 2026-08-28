/**
 * Local QA-only populate for final visual acceptance.
 * Safe fixtures marked origin/source = qa_visual_acceptance | simulator.
 *
 *   $env:DATABASE_URL="postgresql://dmintel:dmintel@127.0.0.1:54329/dm_intelligence_crm"
 *   npx tsx scripts/qa-populate-visual.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const QA = "qa_visual_acceptance";

async function main() {
  const org =
    (await prisma.organisation.findFirst({
      where: {
        deletedAt: null,
        isPlatform: false,
        OR: [
          { name: { contains: "Shobhit Agency QA", mode: "insensitive" } },
          { slug: { contains: "shobhit", mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
    })) ??
    (await prisma.organisation.findFirst({
      where: { deletedAt: null, isPlatform: false },
      orderBy: { createdAt: "desc" },
    }));

  if (!org) throw new Error("No tenant organisation found");
  console.log(`QA populate → ${org.name} (${org.id})`);

  const pipeline = await prisma.pipeline.findFirst({
    where: { organisationId: org.id, isDefault: true },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!pipeline?.stages.length) throw new Error("Default pipeline missing");
  const stages = pipeline.stages;
  const stageBySlug = (slug: string) => stages.find((s) => s.slug === slug) ?? stages[0]!;

  // Companies
  const companySpecs = [
    { name: "Northwind Retail", domain: "northwind-retail.example", industry: "Retail" },
    {
      name: "Brightside Consulting Group International Holdings Ltd",
      domain: "brightside.example",
      industry: "Professional services",
    },
    { name: "Orbit Labs", domain: "orbitlabs.example", industry: "SaaS" },
  ];
  const companies = [];
  for (const c of companySpecs) {
    const existing = await prisma.company.findFirst({
      where: { organisationId: org.id, name: c.name, deletedAt: null },
    });
    companies.push(
      existing ??
        (await prisma.company.create({
          data: {
            organisationId: org.id,
            name: c.name,
            domain: c.domain,
            industry: c.industry,
            metadata: { qa: QA },
          },
        })),
    );
  }

  type Spec = {
    key: string;
    name: string;
    username: string;
    messages: Array<{ body: string; direction: "INBOUND" | "OUTBOUND"; sender: "CONTACT" | "AI" | "HUMAN" }>;
    unread: number;
    needsHuman: boolean;
    handling: "AI" | "HUMAN" | "PAUSED";
    score: number;
    qual: "UNKNOWN" | "QUALIFYING" | "QUALIFIED" | "DISQUALIFIED";
    stageSlug: string;
    objection?: string;
    buying?: string;
    followUpHours?: number;
    priorityClass?: string;
  };

  const specs: Spec[] = [
    {
      key: "needs_reply",
      name: "Ava Chen",
      username: "ava.chen.dm",
      unread: 2,
      needsHuman: false,
      handling: "AI",
      score: 62,
      qual: "QUALIFYING",
      stageSlug: "engaged",
      priorityClass: "REPLY_NEEDED",
      followUpHours: 2,
      messages: [
        { body: "Hi — saw your Instagram ad about lead follow-up.", direction: "INBOUND", sender: "CONTACT" },
        {
          body: "Thanks Ava! Are you looking to book more demos this month?",
          direction: "OUTBOUND",
          sender: "AI",
        },
        {
          body: "Yes. We get ~40 DMs a week and replies take too long. Can you help?",
          direction: "INBOUND",
          sender: "CONTACT",
        },
      ],
    },
    {
      key: "hot_lead",
      name: "Marcus Okafor",
      username: "marcus_ok",
      unread: 1,
      needsHuman: false,
      handling: "AI",
      score: 91,
      qual: "QUALIFIED",
      stageSlug: "qualified",
      priorityClass: "HOT_LEAD",
      buying: "Asked for pricing and a Thursday demo slot",
      messages: [
        { body: "Ready to move. What does onboarding look like?", direction: "INBOUND", sender: "CONTACT" },
        {
          body: "We can start with Instagram DMs + pipeline in under a week.",
          direction: "OUTBOUND",
          sender: "AI",
        },
        {
          body: "Perfect — send a calendar link for Thu 14:00 GMT please.",
          direction: "INBOUND",
          sender: "CONTACT",
        },
      ],
    },
    {
      key: "human_handoff",
      name: "Priya Nandakumar",
      username: "priya.nanda",
      unread: 3,
      needsHuman: true,
      handling: "HUMAN",
      score: 78,
      qual: "QUALIFIED",
      stageSlug: "booking_offered",
      priorityClass: "HUMAN_REQUIRED",
      objection: "Budget is locked until next quarter unless we see ROI proof",
      messages: [
        { body: "Can a human walk me through enterprise SSO?", direction: "INBOUND", sender: "CONTACT" },
        {
          body: "I've paused AI — a teammate will take this shortly.",
          direction: "OUTBOUND",
          sender: "AI",
        },
        {
          body: "Also our legal team needs a DPA. This is a long thread about compliance, data residency, and how Agent Desk handles Instagram tokens across EU workspaces when we expand into DACH next year.",
          direction: "INBOUND",
          sender: "CONTACT",
        },
      ],
    },
    {
      key: "waiting",
      name: "Jo",
      username: "jo_short",
      unread: 0,
      needsHuman: false,
      handling: "AI",
      score: 35,
      qual: "UNKNOWN",
      stageSlug: "contacted",
      priorityClass: "WAITING",
      followUpHours: 48,
      messages: [
        { body: "ok", direction: "INBOUND", sender: "CONTACT" },
        {
          body: "Happy to help when you're ready — any questions on pricing?",
          direction: "OUTBOUND",
          sender: "AI",
        },
      ],
    },
    {
      key: "price_objection",
      name: "Elena Rossi — Growth Ops at Brightside",
      username: "elena.rossi.growth",
      unread: 1,
      needsHuman: false,
      handling: "AI",
      score: 70,
      qual: "QUALIFYING",
      stageSlug: "qualifying",
      priorityClass: "REPLY_NEEDED",
      objection: "Price feels high vs our current spreadsheet workflow",
      messages: [
        { body: "Interesting product. What's monthly for 3 seats?", direction: "INBOUND", sender: "CONTACT" },
        {
          body: "Happy to share plans — roughly how many conversations per week?",
          direction: "OUTBOUND",
          sender: "AI",
        },
        {
          body: "Hmm, that seems expensive compared to doing it manually in Sheets.",
          direction: "INBOUND",
          sender: "CONTACT",
        },
      ],
    },
  ];

  for (const spec of specs) {
    let contact = await prisma.contact.findFirst({
      where: {
        organisationId: org.id,
        instagramUsername: spec.username,
        deletedAt: null,
      },
    });
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          organisationId: org.id,
          fullName: spec.name,
          instagramUsername: spec.username,
          leadSource: "simulator",
          campaignSource: QA,
          companyId: companies[0]?.id,
          metadata: { qa: QA },
        },
      });
    } else {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { fullName: spec.name, companyId: companies[0]?.id },
      });
    }

    const externalThreadId = `sim_thread_${spec.key}`;
    let conversation = await prisma.conversation.findFirst({
      where: { organisationId: org.id, externalThreadId },
    });
    const lastBody = spec.messages[spec.messages.length - 1]?.body.slice(0, 120) ?? null;
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          organisationId: org.id,
          contactId: contact.id,
          externalThreadId,
          handlingMode: spec.handling,
          aiPaused: spec.handling !== "AI",
          needsHumanReview: spec.needsHuman,
          unreadCount: spec.unread,
          lastMessageAt: new Date(),
          lastMessagePreview: lastBody,
          lastInboundAt: new Date(),
          summary: `${spec.name} — QA simulated thread`,
          intent: spec.qual === "QUALIFIED" ? "book_demo" : "learn_more",
          priorityClass: spec.priorityClass,
          metadata: { qa: QA, origin: "simulator" },
        },
      });
    } else {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          handlingMode: spec.handling,
          aiPaused: spec.handling !== "AI",
          needsHumanReview: spec.needsHuman,
          unreadCount: spec.unread,
          lastMessageAt: new Date(),
          lastMessagePreview: lastBody,
          priorityClass: spec.priorityClass,
        },
      });
    }

    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    let t = Date.now() - spec.messages.length * 60_000;
    for (const m of spec.messages) {
      await prisma.message.create({
        data: {
          organisationId: org.id,
          conversationId: conversation.id,
          body: m.body,
          direction: m.direction,
          senderType: m.sender,
          externalId: `sim_msg_${spec.key}_${t}`,
          origin: "simulator",
          sentAt: new Date(t),
        },
      });
      t += 60_000;
    }

    const st = stageBySlug(spec.stageSlug);
    let lead = await prisma.lead.findFirst({
      where: { organisationId: org.id, contactId: contact.id, deletedAt: null },
    });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          organisationId: org.id,
          contactId: contact.id,
          conversationId: conversation.id,
          pipelineId: pipeline.id,
          stageId: st.id,
          score: spec.score,
          qualificationStatus: spec.qual,
          scoreExplanation: "QA fixture score for visual acceptance",
          metadata: { qa: QA },
        },
      });
    } else {
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: {
          stageId: st.id,
          score: spec.score,
          qualificationStatus: spec.qual,
          conversationId: conversation.id,
        },
      });
    }

    await prisma.objection.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.buyingSignal.deleteMany({ where: { conversationId: conversation.id } });
    if (spec.objection) {
      await prisma.objection.create({
        data: {
          organisationId: org.id,
          conversationId: conversation.id,
          category: "price",
          text: spec.objection,
        },
      });
    }
    if (spec.buying) {
      await prisma.buyingSignal.create({
        data: {
          organisationId: org.id,
          conversationId: conversation.id,
          text: spec.buying,
        },
      });
    }
    if (spec.followUpHours != null) {
      await prisma.followUp.deleteMany({ where: { conversationId: conversation.id } });
      await prisma.followUp.create({
        data: {
          organisationId: org.id,
          contactId: contact.id,
          conversationId: conversation.id,
          leadId: lead.id,
          status: "SCHEDULED",
          scheduledFor: new Date(Date.now() + spec.followUpHours * 3600_000),
          attemptNumber: 1,
          messageBody: "QA scheduled follow-up",
        },
      });
    }
  }

  // Pipeline density
  for (let i = 0; i < Math.min(stages.length, 8); i++) {
    const st = stages[i]!;
    const username = `pipe_lead_${i}`;
    let contact = await prisma.contact.findFirst({
      where: { organisationId: org.id, instagramUsername: username, deletedAt: null },
    });
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          organisationId: org.id,
          fullName: i === 3 ? "Alexandra Montenegro-Silva de Oliveira" : `Pipeline Lead ${i + 1}`,
          instagramUsername: username,
          leadSource: "simulator",
          metadata: { qa: QA },
        },
      });
    }
    const existing = await prisma.lead.findFirst({
      where: { organisationId: org.id, contactId: contact.id, deletedAt: null },
    });
    if (!existing) {
      await prisma.lead.create({
        data: {
          organisationId: org.id,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: st.id,
          score: 40 + i * 5,
          qualificationStatus: i > 4 ? "QUALIFIED" : "QUALIFYING",
          metadata: { qa: QA },
        },
      });
    } else {
      await prisma.lead.update({ where: { id: existing.id }, data: { stageId: st.id } });
    }
  }

  // Deals — delete prior QA by name prefix
  await prisma.deal.deleteMany({
    where: { organisationId: org.id, name: { startsWith: "QA " } },
  });
  const dealDefs = [
    {
      name: "QA Northwind Instagram inbox rollout",
      amountCents: 480_000,
      status: "OPEN" as const,
      stageLabel: "Proposal",
      companyId: companies[0]?.id,
    },
    {
      name: "QA Brightside enterprise workspace for DACH expansion and multi-brand content ops",
      amountCents: 2_400_000,
      status: "OPEN" as const,
      stageLabel: "Negotiation",
      companyId: companies[1]?.id,
    },
    {
      name: "QA Orbit Labs starter",
      amountCents: 99_000,
      status: "WON" as const,
      stageLabel: "Closed won",
      companyId: companies[2]?.id,
    },
    {
      name: "QA Pilot — short",
      amountCents: 15_000,
      status: "LOST" as const,
      stageLabel: "Closed lost",
      companyId: companies[2]?.id,
    },
  ];
  for (const d of dealDefs) {
    await prisma.deal.create({
      data: {
        organisationId: org.id,
        name: d.name,
        amountCents: d.amountCents,
        currency: "GBP",
        status: d.status,
        stageLabel: d.stageLabel,
        companyId: d.companyId,
        summary: "QA visual acceptance deal fixture",
        metadata: { qa: QA },
      },
    });
  }

  // Goal
  let goal = await prisma.goal.findFirst({
    where: { organisationId: org.id, name: "Q3 qualified demos" },
  });
  if (!goal) {
    goal = await prisma.goal.create({
      data: {
        organisationId: org.id,
        name: "Q3 qualified demos",
        description: "Book 20 qualified demos from Instagram DMs",
        category: "REVENUE",
        status: "ACTIVE",
        source: QA,
        priority: 10,
      },
    });
  } else {
    await prisma.goal.update({
      where: { id: goal.id },
      data: { status: "ACTIVE", source: QA },
    });
  }

  // Opportunities
  await prisma.businessOpportunity.deleteMany({
    where: { organisationId: org.id, source: QA },
  });
  const opps = [
    {
      type: "DEAL_RISK" as const,
      title: "Qualified leads waiting over 24h for a reply",
      summary:
        "Several qualified Instagram leads have unread inbound messages. Faster replies usually improve meeting conversion.",
      urgency: "HIGH" as const,
      impact: "HIGH" as const,
      confidence: "MEDIUM" as const,
      priorityScore: 88,
      dedupeKey: `${QA}:deal_risk_reply`,
    },
    {
      type: "CONTENT_GAP" as const,
      title: "Price objection pattern needs a proof content piece",
      summary:
        "Multiple conversations mention spreadsheet cost. A short ROI story would help Agent Desk answer consistently.",
      urgency: "MEDIUM" as const,
      impact: "MEDIUM" as const,
      confidence: "MEDIUM" as const,
      priorityScore: 72,
      dedupeKey: `${QA}:content_gap_price`,
    },
    {
      type: "REACTIVATION" as const,
      title: "Re-engage Jo — quiet after first reply",
      summary: "Contact went quiet after a short acknowledgement. A light follow-up may reopen the thread.",
      urgency: "LOW" as const,
      impact: "LOW" as const,
      confidence: "LOW" as const,
      priorityScore: 41,
      dedupeKey: `${QA}:reactivation_jo`,
    },
  ];
  for (const o of opps) {
    const created = await prisma.businessOpportunity.create({
      data: {
        organisationId: org.id,
        type: o.type,
        title: o.title,
        summary: o.summary,
        status: "DETECTED",
        impact: o.impact,
        urgency: o.urgency,
        confidence: o.confidence,
        priorityScore: o.priorityScore,
        goalId: goal.id,
        source: QA,
        dedupeKey: o.dedupeKey,
        qualityGateStatus: "PASSED",
      },
    });
    await prisma.opportunityEvidence.create({
      data: {
        organisationId: org.id,
        opportunityId: created.id,
        evidenceType: "observation",
        label: "QA fixture evidence",
        detail: "Seeded for visual acceptance — not a live detector run.",
      },
    });
  }

  // Research
  await prisma.researchJob.deleteMany({
    where: { organisationId: org.id, topic: { contains: "QA visual" } },
  });
  const research = await prisma.researchJob.create({
    data: {
      organisationId: org.id,
      kind: "RESEARCH",
      topic:
        "QA visual — How Instagram lead response time affects B2B demo booking rates in professional services",
      status: "COMPLETED",
      queries: ["instagram dm response time demos", "b2b messaging sla"],
      brief: {
        summary:
          "Faster first replies generally correlate with higher meeting rates; exact lift depends on offer and audience.",
        findings: [
          "Sub-4 hour replies are commonly associated with better progression in high-intent DMs.",
          "Price objections appear more often when proof content is thin.",
        ],
      },
      contradictions: [
        "Some sources claim channel quality matters more than speed — treat speed as one lever, not the only one.",
      ],
      gaps: ["Limited public data specific to Instagram DM SLAs in UK agencies."],
      startedAt: new Date(Date.now() - 86400_000),
      finishedAt: new Date(),
    },
  });
  const source = await prisma.researchSource.create({
    data: {
      organisationId: org.id,
      researchJobId: research.id,
      title: "Internal QA note on reply SLAs",
      url: "https://example.com/qa/reply-sla",
      platform: "web",
      author: "QA Fixture",
      retrievedAt: new Date(),
      content: "Faster replies often improve conversion for warm inbound conversations.",
    },
  });
  await prisma.researchFinding.create({
    data: {
      organisationId: org.id,
      researchJobId: research.id,
      researchSourceId: source.id,
      claim: "Faster replies improve demo booking likelihood for warm Instagram leads.",
      confidence: 0.6,
          claimKind: "OBSERVATION",
      evidenceExcerpt: "Faster replies often improve conversion for warm inbound conversations.",
    },
  });

  // Content
  await prisma.contentPiece.deleteMany({
    where: { organisationId: org.id, title: { startsWith: "QA " } },
  });
  const contentDefs = [
    { title: "QA Draft — soft CTA", status: "DRAFT" as const, platform: "instagram" },
    { title: "QA Ready — ROI carousel outline", status: "APPROVED" as const, platform: "instagram" },
    {
      title: "QA Awaiting approval — Long title about why response time compounds across a busy agency week",
      status: "IN_REVIEW" as const,
      platform: "linkedin",
    },
    { title: "QA Scheduled — Thursday tip", status: "SCHEDULED" as const, platform: "instagram" },
    { title: "QA Published — welcome story", status: "PUBLISHED" as const, platform: "instagram" },
    { title: "QA Needs attention — publish failed", status: "FAILED" as const, platform: "instagram" },
  ];
  for (const c of contentDefs) {
    const piece = await prisma.contentPiece.create({
      data: {
        organisationId: org.id,
        title: c.title,
        body: "QA fixture body for visual acceptance. Keep tone calm and commercial.",
        status: c.status,
        platform: c.platform,
        whyEvidence: { qa: QA },
      },
    });
    if (c.status === "FAILED" || c.status === "SCHEDULED" || c.status === "PUBLISHED") {
      await prisma.publishingJob.create({
        data: {
          organisationId: org.id,
          pieceId: piece.id,
          platform: c.platform,
          status: c.status === "FAILED" ? "FAILED" : c.status === "PUBLISHED" ? "PUBLISHED" : "SCHEDULED",
          externalOutcome:
            c.status === "FAILED" ? "FAILED" : c.status === "PUBLISHED" ? "CONFIRMED" : "NOT_STARTED",
          error:
            c.status === "FAILED"
              ? "The Instagram connection rejected the publish request. Reconnect the channel and try again."
              : null,
          scheduledAt: c.status === "SCHEDULED" ? new Date(Date.now() + 86400_000) : null,
          externalUrl: c.status === "PUBLISHED" ? "https://instagram.com/p/qa-fixture" : null,
          idempotencyKey: `qa-pub-${c.status}-${piece.id}`,
        },
      });
    }
  }

  if ((await prisma.productOffering.count({ where: { organisationId: org.id } })) === 0) {
    await prisma.productOffering.create({
      data: {
        organisationId: org.id,
        name: "Agent Desk — Instagram inbox + CRM",
        status: "ACTIVE",
        description: "Qualify Instagram DMs and move leads through pipeline",
      },
    });
  }
  if ((await prisma.audienceSegment.count({ where: { organisationId: org.id } })) === 0) {
    await prisma.audienceSegment.create({
      data: {
        organisationId: org.id,
        name: "UK agency founders",
        description: "Service businesses booking demos from Instagram",
      },
    });
  }

  console.log("QA populate complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
