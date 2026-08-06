import { hash } from "bcryptjs";
import { MemberRole, KnowledgeDocStatus } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { chunkText } from "../src/services/knowledge";

const prisma = new PrismaClient();

const DEFAULT_STAGES = [
  { name: "New", slug: "new", position: 0, color: "#94a3b8" },
  { name: "Contacted", slug: "contacted", position: 1, color: "#60a5fa" },
  { name: "Engaged", slug: "engaged", position: 2, color: "#38bdf8" },
  { name: "Qualifying", slug: "qualifying", position: 3, color: "#a78bfa" },
  { name: "Qualified", slug: "qualified", position: 4, color: "#34d399" },
  { name: "Booking offered", slug: "booking_offered", position: 5, color: "#fbbf24" },
  { name: "Booked", slug: "booked", position: 6, color: "#f59e0b", isWon: false },
  { name: "Nurture", slug: "nurture", position: 7, color: "#c084fc" },
  { name: "Won", slug: "won", position: 8, color: "#22c55e", isWon: true },
  { name: "Lost", slug: "lost", position: 9, color: "#ef4444", isLost: true },
  { name: "Disqualified", slug: "disqualified", position: 10, color: "#78716c", isLost: true },
];

async function main() {
  const isProduction = process.env.NODE_ENV === "production";
  const demoMode = process.env.DEMO_MODE === "true";

  if (isProduction && !demoMode) {
    console.log("Skipping demo seed in production with DEMO_MODE=false");
    return;
  }

  const passwordHash = await hash("demo1234", 10);

  const org = await prisma.organisation.upsert({
    where: { slug: "demo-agency" },
    update: { demoData: true },
    create: {
      name: "Demo Agency",
      slug: "demo-agency",
      timezone: "Europe/London",
      demoData: true,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: "demo@dminelligence.local" },
    update: { passwordHash, name: "Demo Owner" },
    create: {
      email: "demo@dminelligence.local",
      name: "Demo Owner",
      passwordHash,
    },
  });

  await prisma.organisationMember.upsert({
    where: {
      organisationId_userId: {
        organisationId: org.id,
        userId: user.id,
      },
    },
    update: { role: MemberRole.OWNER },
    create: {
      organisationId: org.id,
      userId: user.id,
      role: MemberRole.OWNER,
    },
  });

  const pipeline = await prisma.pipeline.upsert({
    where: {
      organisationId_name: {
        organisationId: org.id,
        name: "Default Sales Pipeline",
      },
    },
    update: { isDefault: true },
    create: {
      organisationId: org.id,
      name: "Default Sales Pipeline",
      isDefault: true,
    },
  });

  for (const stage of DEFAULT_STAGES) {
    await prisma.pipelineStage.upsert({
      where: {
        pipelineId_slug: {
          pipelineId: pipeline.id,
          slug: stage.slug,
        },
      },
      update: {
        name: stage.name,
        position: stage.position,
        color: stage.color,
        isWon: stage.isWon ?? false,
        isLost: stage.isLost ?? false,
      },
      create: {
        pipelineId: pipeline.id,
        name: stage.name,
        slug: stage.slug,
        position: stage.position,
        color: stage.color,
        isWon: stage.isWon ?? false,
        isLost: stage.isLost ?? false,
      },
    });
  }

  await prisma.messagingChannel.upsert({
    where: {
      organisationId_provider_externalId: {
        organisationId: org.id,
        provider: "manychat",
        externalId: "default",
      },
    },
    update: { displayName: "Demo Instagram", isActive: true },
    create: {
      organisationId: org.id,
      provider: "manychat",
      externalId: "default",
      displayName: "Demo Instagram",
      instagramUsername: "demo_brand",
      isActive: true,
    },
  });

  // Second org + membership so multi-org switcher can be exercised in demo.
  const secondOrg = await prisma.organisation.upsert({
    where: { slug: "northstar-studio" },
    update: { demoData: true },
    create: {
      name: "Northstar Studio",
      slug: "northstar-studio",
      timezone: "Europe/London",
      demoData: true,
    },
  });

  await prisma.organisationMember.upsert({
    where: {
      organisationId_userId: {
        organisationId: secondOrg.id,
        userId: user.id,
      },
    },
    update: { role: MemberRole.OWNER },
    create: {
      organisationId: secondOrg.id,
      userId: user.id,
      role: MemberRole.OWNER,
    },
  });

  const secondPipeline = await prisma.pipeline.upsert({
    where: {
      organisationId_name: {
        organisationId: secondOrg.id,
        name: "Default Sales Pipeline",
      },
    },
    update: { isDefault: true },
    create: {
      organisationId: secondOrg.id,
      name: "Default Sales Pipeline",
      isDefault: true,
    },
  });

  for (const stage of DEFAULT_STAGES) {
    await prisma.pipelineStage.upsert({
      where: {
        pipelineId_slug: {
          pipelineId: secondPipeline.id,
          slug: stage.slug,
        },
      },
      update: {
        name: stage.name,
        position: stage.position,
        color: stage.color,
        isWon: stage.isWon ?? false,
        isLost: stage.isLost ?? false,
      },
      create: {
        pipelineId: secondPipeline.id,
        name: stage.name,
        slug: stage.slug,
        position: stage.position,
        color: stage.color,
        isWon: stage.isWon ?? false,
        isLost: stage.isLost ?? false,
      },
    });
  }

  await prisma.messagingChannel.upsert({
    where: {
      organisationId_provider_externalId: {
        organisationId: secondOrg.id,
        provider: "manychat",
        externalId: "northstar_ig",
      },
    },
    update: { displayName: "Northstar Instagram", isActive: true },
    create: {
      organisationId: secondOrg.id,
      provider: "manychat",
      externalId: "northstar_ig",
      displayName: "Northstar Instagram",
      instagramUsername: "northstar_studio",
      isActive: true,
    },
  });

  await prisma.agentConfiguration.deleteMany({ where: { organisationId: secondOrg.id } });
  await prisma.agentConfiguration.create({
    data: {
      organisationId: secondOrg.id,
      name: "Default Agent",
      isActive: true,
      isDraft: false,
      aiProvider: process.env.AI_PROVIDER || "mock",
      model: process.env.AI_PROVIDER === "openai" ? "gpt-4o-mini" : "mock-v1",
      brandTone: "professional, warm, clear",
      formality: "professional",
      responseLength: "medium",
      emojiUsage: "minimal",
      qualificationQuestions: ["What type of business do you run?"],
      scoringRules: { weights: { businessFit: 20, need: 15, urgency: 10, budget: 15 } },
      bookingUrl: process.env.DEFAULT_BOOKING_URL || "https://calendly.com/example/intro-call",
      confidenceThreshold: 0.65,
      maxFollowUps: 3,
      followUpDelaysMinutes: [60, 1440, 4320],
      restrictedTopics: ["medical advice"],
    },
  });

  await prisma.agentConfiguration.deleteMany({ where: { organisationId: org.id } });
  await prisma.agentConfiguration.create({
    data: {
      organisationId: org.id,
      name: "Default Agent",
      isActive: true,
      isDraft: false,
      aiProvider: process.env.AI_PROVIDER || "mock",
      model: process.env.AI_PROVIDER === "openai" ? "gpt-4o-mini" : "mock-v1",
      brandTone: "professional, warm, clear",
      formality: "professional",
      responseLength: "medium",
      emojiUsage: "minimal",
      qualificationQuestions: [
        "What type of business do you run?",
        "Roughly how many Instagram DMs do you receive per month?",
        "What is your monthly budget range for a solution like this?",
      ],
      scoringRules: {
        weights: {
          businessFit: 20,
          need: 15,
          urgency: 10,
          budget: 15,
          authority: 10,
          engagement: 10,
          sentiment: 10,
          buyingSignals: 10,
        },
      },
      bookingUrl: process.env.DEFAULT_BOOKING_URL || "https://calendly.com/example/intro-call",
      confidenceThreshold: 0.65,
      maxFollowUps: 3,
      followUpDelaysMinutes: [60, 1440, 4320],
      restrictedTopics: ["medical advice", "guaranteed ROI claims"],
    },
  });

  const knowledgeDocs = [
    {
      title: "Business overview",
      category: "business",
      content:
        "DM Intelligence CRM helps service businesses convert Instagram DMs into booked sales calls using AI-assisted qualification, follow-ups, and pipeline tracking.",
    },
    {
      title: "Pricing guidance",
      category: "pricing",
      content:
        "Starter packages typically begin around £497/month for a single Instagram inbox. Growth plans are available for higher DM volume. Never invent custom discounts. Direct detailed pricing discussions to a discovery call.",
    },
    {
      title: "Qualification criteria",
      category: "sop",
      content:
        "Qualify leads who run a business, receive recurring Instagram enquiries, and have authority or influence over buying decisions. Disqualify leads seeking free work only, job seekers, or anyone who opts out.",
    },
    {
      title: "Tone of voice",
      category: "tone",
      content:
        "Be concise, confident, and helpful. Avoid hype. Do not use excessive emojis. Ask one clear question at a time.",
    },
    {
      title: "FAQ",
      category: "faq",
      content:
        "Q: How fast do you respond?\nA: AI responds instantly during operating hours; humans take over when needed.\nQ: Can I pause the AI?\nA: Yes, any teammate can pause AI and reply manually from the inbox.",
    },
  ];

  for (const doc of knowledgeDocs) {
    const existing = await prisma.knowledgeDocument.findFirst({
      where: { organisationId: org.id, title: doc.title },
    });
    if (existing) {
      await prisma.knowledgeChunk.deleteMany({ where: { documentId: existing.id } });
      await prisma.knowledgeDocument.update({
        where: { id: existing.id },
        data: {
          content: doc.content,
          category: doc.category,
          status: KnowledgeDocStatus.ACTIVE,
        },
      });
      await prisma.knowledgeChunk.createMany({
        data: chunkText(doc.content).map((content) => ({
          documentId: existing.id,
          content,
        })),
      });
    } else {
      await prisma.knowledgeDocument.create({
        data: {
          organisationId: org.id,
          title: doc.title,
          category: doc.category,
          content: doc.content,
          status: KnowledgeDocStatus.ACTIVE,
          chunks: {
            create: chunkText(doc.content).map((content) => ({ content })),
          },
        },
      });
    }
  }

  const fields = [
    { key: "business_type", label: "Business type", required: true, weight: 20, position: 0 },
    { key: "monthly_dm_volume", label: "Monthly DM volume", required: true, weight: 15, position: 1 },
    { key: "budget", label: "Budget", required: false, weight: 15, position: 2 },
  ];

  for (const field of fields) {
    await prisma.qualificationField.upsert({
      where: {
        organisationId_key: {
          organisationId: org.id,
          key: field.key,
        },
      },
      update: field,
      create: { organisationId: org.id, ...field },
    });
  }

  await prisma.automationRule.deleteMany({ where: { organisationId: org.id } });
  await prisma.automationRule.createMany({
    data: [
      {
        organisationId: org.id,
        name: "Follow up after inactivity",
        triggerType: "no_reply",
        conditions: { minutes: 60 },
        actions: [{ type: "send_follow_up" }],
        isActive: true,
      },
      {
        organisationId: org.id,
        name: "Stop follow-ups on reply",
        triggerType: "lead_replied",
        conditions: {},
        actions: [{ type: "cancel_follow_ups" }],
        isActive: true,
      },
      {
        organisationId: org.id,
        name: "Handover on human request",
        triggerType: "human_requested",
        conditions: {},
        actions: [{ type: "handover" }],
        isActive: true,
      },
    ],
  });

  console.log("Seed complete");
  console.log("Demo login: demo@dminelligence.local / demo1234");
  console.log(`Organisation: ${org.name} (${org.id})`);
  console.log(`Second organisation: ${secondOrg.name} (${secondOrg.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
