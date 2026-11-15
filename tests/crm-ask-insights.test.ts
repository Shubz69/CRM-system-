/**
 * Ask card data builders: lead pipeline, DM triage, objections, weekly results — and
 * the crm_desk intents that use them. Prisma is mocked; builders are pure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  pipelineStage: { findMany: vi.fn(async () => [] as unknown[]) },
  lead: {
    groupBy: vi.fn(async () => [] as unknown[]),
    findMany: vi.fn(async () => [] as unknown[]),
    count: vi.fn(async () => 0),
  },
  conversation: { findMany: vi.fn(async () => [] as unknown[]), count: vi.fn(async () => 0) },
  objection: { findMany: vi.fn(async () => [] as unknown[]) },
  booking: { count: vi.fn(async () => 0) },
  message: { count: vi.fn(async () => 0) },
  followUp: { count: vi.fn(async () => 0) },
  deal: { findMany: vi.fn(async () => [] as unknown[]) },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/services/chief-of-staff", () => ({ buildChiefOfStaffFacts: vi.fn(async () => null) }));
vi.mock("@/services/knowledge", () => ({ retrieveRelevantKnowledge: vi.fn(async () => null) }));
vi.mock("@/services/digital-twin", () => ({ getBusinessProfile: vi.fn(async () => null) }));
vi.mock("@/services/business-evidence-pack", () => ({ buildBusinessEvidencePack: vi.fn(async () => null) }));

import {
  HOT_LEAD_SCORE,
  buildDmTriage,
  buildLeadPipelineSummary,
  buildObjectionSummary,
  formatDmTriageLines,
  formatLeadPipelineLines,
  formatObjectionLines,
  formatResultsLines,
  loadDmTriage,
  loadLeadPipelineSummary,
  loadObjectionSummary,
  loadResultsReport,
  nextActionForLead,
  suggestDmNextStep,
  type DmConversationRow,
  type LeadRow,
  type PipelineStageRow,
  type ResultsReport,
} from "@/services/crm-ask-insights";
import { crmDeskAgent } from "@/agents/crm-desk";

const NOW = new Date("2026-11-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000);

const pipeline = { id: "pl_1", name: "Sales", isDefault: true };
const STAGES: PipelineStageRow[] = [
  { id: "st_new", name: "New", slug: "new", position: 0, isWon: false, isLost: false, pipeline },
  { id: "st_qual", name: "Qualifying", slug: "qualifying", position: 1, isWon: false, isLost: false, pipeline },
  { id: "st_ok", name: "Qualified", slug: "qualified", position: 2, isWon: false, isLost: false, pipeline },
  { id: "st_won", name: "Won", slug: "won", position: 3, isWon: true, isLost: false, pipeline },
  { id: "st_lost", name: "Lost", slug: "lost", position: 4, isWon: false, isLost: true, pipeline },
];

function lead(over: Partial<LeadRow> & { id: string }): LeadRow {
  return {
    score: 0,
    qualificationStatus: "QUALIFYING",
    stageId: "st_new",
    updatedAt: hoursAgo(2),
    contact: { fullName: over.id, instagramUsername: null },
    conversation: { lastMessageAt: hoursAgo(2), needsHumanReview: false, handlingMode: "AI" },
    ...over,
  };
}

const LEADS: LeadRow[] = [
  lead({ id: "Amy", score: 85, stageId: "st_ok" }),
  lead({ id: "Bea", score: 40, stageId: "st_qual", updatedAt: daysAgo(10), conversation: { lastMessageAt: daysAgo(9), needsHumanReview: false, handlingMode: "AI" } }),
  lead({ id: "Cal", score: 20, stageId: "st_new", conversation: { lastMessageAt: hoursAgo(1), needsHumanReview: true, handlingMode: "AI" } }),
  lead({ id: "Dee", score: 90, stageId: "st_won" }),
  lead({ id: "Eve", score: 75, stageId: "st_qual", qualificationStatus: "DISQUALIFIED" }),
];
const STAGE_COUNTS = [
  { stageId: "st_new", count: 3 },
  { stageId: "st_qual", count: 2 },
  { stageId: "st_ok", count: 1 },
  { stageId: "st_won", count: 1 },
  { stageId: "st_lost", count: 2 },
  { stageId: null, count: 1 },
];

describe("lead pipeline summary", () => {
  it("counts per stage, separates won/lost, flags stalled and hot leads", () => {
    const s = buildLeadPipelineSummary({ stages: STAGES, stageCounts: STAGE_COUNTS, leads: LEADS, now: NOW });
    expect(s.totalLeads).toBe(10);
    expect(s.wonLeads).toBe(1);
    expect(s.lostLeads).toBe(2);
    expect(s.openLeads).toBe(7);
    expect(s.stages.map((x) => [x.name, x.count])).toEqual([
      ["New", 3],
      ["Qualifying", 2],
      ["Qualified", 1],
      ["Won", 1],
      ["Lost", 2],
      ["No stage yet", 1],
    ]);
    expect(s.stalled.map((l) => l.name)).toEqual(["Bea"]);
    expect(s.stalled[0]!.daysQuiet).toBe(9);
    // Won (Dee) and disqualified (Eve) leads are never "hot" open leads.
    expect(s.hot.map((l) => l.name)).toEqual(["Amy"]);
    expect(s.hotIsFallback).toBe(false);
    expect(s.needsHuman.map((l) => l.name)).toEqual(["Cal"]);
    expect(s.nextActions[0]).toMatch(/^Cal .*Reply personally/);
    expect(s.nextActions.some((a) => /^Amy .*booking link/i.test(a))).toBe(true);
    expect(s.nextActions.some((a) => /^Bea .*Re-engage/.test(a))).toBe(true);
  });

  it("falls back to highest-scoring leads when none reach the hot threshold", () => {
    const s = buildLeadPipelineSummary({
      stages: STAGES,
      stageCounts: [{ stageId: "st_new", count: 2 }],
      leads: [lead({ id: "Low", score: 30 }), lead({ id: "Zero", score: 0 })],
      now: NOW,
    });
    expect(s.hotIsFallback).toBe(true);
    expect(s.hot.map((l) => l.name)).toEqual(["Low"]);
    expect(formatLeadPipelineLines(s).join("\n")).toMatch(new RegExp(`none scored ${HOT_LEAD_SCORE}\\+ yet`));
  });

  it("formats stage counts, stalled leads, hot leads and next actions", () => {
    const text = formatLeadPipelineLines(
      buildLeadPipelineSummary({ stages: STAGES, stageCounts: STAGE_COUNTS, leads: LEADS, now: NOW }),
    ).join("\n");
    expect(text).toMatch(/LEAD PIPELINE — 7 open leads \(1 won, 2 lost\/disqualified\)/);
    expect(text).toMatch(/By stage: New 3 · Qualifying 2 · Qualified 1/);
    expect(text).toMatch(/STUCK \/ STALLED LEADS .*: 1\n• Bea — Qualifying, quiet 9 days/);
    expect(text).toMatch(/HOT LEADS \(score 70\+\): 1\n• Amy — score 85, Qualified/);
    expect(text).toMatch(/NEXT ACTIONS\n1\. /);
  });

  it("says plainly when there are no leads", () => {
    const s = buildLeadPipelineSummary({ stages: STAGES, stageCounts: [], leads: [], now: NOW });
    expect(formatLeadPipelineLines(s).join(" ")).toMatch(/No leads in this workspace yet/);
  });

  it("next action follows the stage", () => {
    expect(nextActionForLead({ stageSlug: "qualified", score: 80, daysQuiet: 0, needsHuman: false })).toMatch(/booking link/);
    expect(nextActionForLead({ stageSlug: "new", score: 0, daysQuiet: 0, needsHuman: false })).toMatch(/qualifying question/);
    expect(nextActionForLead({ stageSlug: "booking_offered", score: 0, daysQuiet: 8, needsHuman: false })).toMatch(
      /^Re-engage \(quiet 8 days\): chase the booking/,
    );
  });

  it("loader reads org-scoped live leads and stages", async () => {
    prismaMocks.pipelineStage.findMany.mockResolvedValueOnce(STAGES);
    prismaMocks.lead.groupBy.mockResolvedValueOnce(
      STAGE_COUNTS.map((c) => ({ stageId: c.stageId, _count: { _all: c.count } })),
    );
    prismaMocks.lead.findMany.mockResolvedValueOnce(LEADS);
    const s = await loadLeadPipelineSummary("org_1", NOW);
    expect(s.totalLeads).toBe(10);
    const groupArgs = prismaMocks.lead.groupBy.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(groupArgs.where).toEqual({ organisationId: "org_1", deletedAt: null, contact: { deletedAt: null } });
    const stageArgs = prismaMocks.pipelineStage.findMany.mock.calls[0]![0] as { where: unknown };
    expect(stageArgs.where).toEqual({ pipeline: { organisationId: "org_1" } });
  });
});

function conv(over: Partial<DmConversationRow> & { id: string }): DmConversationRow {
  return {
    needsHumanReview: false,
    handlingMode: "AI",
    unreadCount: 0,
    lastMessageAt: hoursAgo(3),
    lastInboundAt: hoursAgo(3),
    lastOutboundAt: hoursAgo(4),
    lastMessagePreview: "Hi!",
    handoffReason: null,
    intent: null,
    priorityClass: null,
    messagingWindowExpiresAt: null,
    contact: { fullName: over.id, instagramUsername: null },
    leads: [],
    ...over,
  };
}

describe("DM triage", () => {
  const rows = [
    conv({ id: "Answered", lastInboundAt: hoursAgo(5), lastOutboundAt: hoursAgo(1) }),
    conv({
      id: "Pricey",
      lastMessagePreview: "How much is a bridal trial?",
      lastInboundAt: hoursAgo(6),
      lastOutboundAt: hoursAgo(8),
    }),
    conv({
      id: "Human",
      needsHumanReview: true,
      handoffReason: "Asked for a person",
      lastInboundAt: hoursAgo(1),
      lastOutboundAt: null,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 5 * 60 * 60 * 1000),
    }),
    conv({
      id: "Hot",
      lastMessagePreview: "Sounds great",
      lastInboundAt: hoursAgo(2),
      leads: [{ score: 82, qualificationStatus: "QUALIFIED", stage: { name: "Qualified", slug: "qualified" } }],
    }),
    conv({ id: "Unread", unreadCount: 2, lastInboundAt: hoursAgo(9), lastOutboundAt: hoursAgo(1) }),
  ];

  it("keeps threads needing a human or a reply, human first, then hot, then longest waiting", () => {
    const t = buildDmTriage(rows, NOW);
    expect(t.needsHuman).toBe(1);
    expect(t.awaitingReply).toBe(3);
    expect(t.items.map((i) => i.name)).toEqual(["Human", "Hot", "Unread", "Pricey"]);
  });

  it("suggests a concrete next step per thread", () => {
    const t = buildDmTriage(rows, NOW);
    const step = (name: string) => t.items.find((i) => i.name === name)!.nextStep;
    expect(step("Human")).toMatch(/^Reply personally \(handed over: Asked for a person\)/);
    expect(step("Human")).toMatch(/5h left in the 24-hour messaging window/);
    expect(step("Pricey")).toMatch(/^Answer the price question/);
    expect(step("Hot")).toMatch(/booking link/i);
    expect(suggestDmNextStep(conv({ id: "x", lastMessagePreview: "Do you have availability on Saturday?" }), NOW)).toMatch(
      /booking link/,
    );
  });

  it("formats the list with last message and next step, and the empty case", () => {
    const text = formatDmTriageLines(buildDmTriage(rows, NOW)).join("\n");
    expect(text).toMatch(/DMs TO HANDLE — 4 conversations \(1 flagged for a human, 3 waiting for a reply\)/);
    expect(text).toMatch(/Last message: “How much is a bridal trial\?”/);
    expect(text).toMatch(/→ Next step: /);
    expect(text).toMatch(/Nothing has been sent/);
    expect(formatDmTriageLines(buildDmTriage([rows[0]!], NOW)).join(" ")).toMatch(/none right now/);
  });

  it("loader reads open, live conversations for this org only", async () => {
    prismaMocks.conversation.findMany.mockResolvedValueOnce(rows);
    const t = await loadDmTriage("org_1", NOW);
    expect(t.items).toHaveLength(4);
    const args = prismaMocks.conversation.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({
      organisationId: "org_1",
      deletedAt: null,
      closedAt: null,
      contact: { deletedAt: null },
    });
  });
});

describe("objections", () => {
  const objectionRows = [
    { category: "PRICE", text: "That's more than I expected", detectedAt: daysAgo(1), conversation: { contact: { fullName: "Holly", instagramUsername: null } } },
    { category: "cost", text: "Is there a cheaper option?", detectedAt: daysAgo(2), conversation: null },
    { category: "PRICE", text: "PRICE", detectedAt: daysAgo(3), conversation: null },
    { category: "timing", text: "Wedding isn't until 2028", detectedAt: daysAgo(4), conversation: null },
    { category: "TRUST", text: "Old one", detectedAt: daysAgo(20), conversation: null },
  ];

  it("groups the last 7 days by normalised category with counts, examples and responses", () => {
    const s = buildObjectionSummary(objectionRows, NOW);
    expect(s.total).toBe(4);
    expect(s.categories.map((c) => [c.category, c.count])).toEqual([
      ["PRICE", 3],
      ["TIMING", 1],
    ]);
    const price = s.categories[0]!;
    // The bare category text is not an example; examples are newest first, max 2.
    expect(price.examples).toEqual(["“That's more than I expected” — Holly", "“Is there a cheaper option?”"]);
    expect(price.suggestedResponse).toMatch(/price range/);
    const text = formatObjectionLines(s).join("\n");
    expect(text).toMatch(/OBJECTIONS — last 7 days: 4 across 2 categories/);
    expect(text).toMatch(/1\. Price — 3 \(75%\)/);
    expect(text).toMatch(/→ Suggested response:/);
  });

  it("falls back clearly when nothing was recorded this week", () => {
    const s = buildObjectionSummary([objectionRows[4]!], NOW);
    expect(s.total).toBe(0);
    const text = formatObjectionLines(s).join("\n");
    expect(text).toMatch(/none recorded/);
    expect(text).toMatch(/Earlier this month: Trust \(1\)/);
    expect(formatObjectionLines(buildObjectionSummary([], NOW)).join(" ")).toMatch(
      /No objections were detected in your conversations in the last 7 days/,
    );
  });

  it("loader is org-scoped and excludes soft-deleted conversations", async () => {
    prismaMocks.objection.findMany.mockResolvedValueOnce(objectionRows);
    const s = await loadObjectionSummary("org_1", NOW);
    expect(s.total).toBe(4);
    const args = prismaMocks.objection.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organisationId: "org_1",
      OR: [{ conversationId: null }, { conversation: { deletedAt: null, contact: { deletedAt: null } } }],
    });
  });
});

describe("weekly results", () => {
  const report: ResultsReport = {
    periodStart: daysAgo(7),
    periodEnd: NOW,
    current: { conversations: 12, newLeads: 10, qualified: 4, bookings: 3, messagesReceived: 60, repliesSent: 45, followUpsSent: 5 },
    previous: { conversations: 9, newLeads: 7, qualified: 2, bookings: 1, messagesReceived: 41, repliesSent: 30, followUpsSent: 3 },
    conversion: 3 / 12,
    previousConversion: 1 / 9,
    topObjections: [{ label: "Price", count: 5 }],
    stalledLeads: [{ name: "Bea", stage: "Qualifying", daysQuiet: 9 }],
    openLeads: 7,
  };

  it("compares this week with last week and lists what moved / stalled", () => {
    const text = formatResultsLines(report).join("\n");
    expect(text).toMatch(/RESULTS — last 7 days \(8 Nov – 15 Nov\) vs the 7 days before/);
    expect(text).toMatch(/New conversations: 12 \(previous 9, \+3\)/);
    expect(text).toMatch(/Qualified leads: 4 \(previous 2, \+2\)/);
    expect(text).toMatch(/Bookings \/ meetings: 3 \(previous 1, \+2\)/);
    expect(text).toMatch(/Replies sent: 45 \(previous 30, \+15\)/);
    expect(text).toMatch(/Conversion \(bookings ÷ new conversations\): 25% \(previous 11%\)/);
    expect(text).toMatch(/WHAT MOVED\n• replies sent up 15/);
    expect(text).toMatch(/1 open lead quiet 7\+ days: Bea \(Qualifying, 9d\)/);
    expect(text).toMatch(/Top objections this week: Price \(5\)/);
    expect(text).toMatch(/No web research/);
  });

  it("loader counts both 7-day windows with the Reports definitions", async () => {
    prismaMocks.conversation.count.mockResolvedValue(4);
    prismaMocks.booking.count.mockResolvedValue(1);
    const r = await loadResultsReport("org_1", NOW);
    expect(r.current.conversations).toBe(4);
    expect(r.conversion).toBe(0.25);
    expect(prismaMocks.conversation.count).toHaveBeenCalledTimes(2);
    const [cur, prev] = prismaMocks.conversation.count.mock.calls.map(
      (c) => (c[0] as { where: { createdAt: { gte: Date; lt: Date } } }).where,
    );
    expect(cur!.createdAt.gte).toEqual(daysAgo(7));
    expect(prev!.createdAt).toEqual({ gte: daysAgo(14), lt: daysAgo(7) });
    expect(cur).toMatchObject({ organisationId: "org_1", deletedAt: null, contact: { deletedAt: null } });
    const bookingWhere = (prismaMocks.booking.count.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(bookingWhere.status).toEqual({ in: ["CREATED", "ATTENDED"] });
    const replyWhere = prismaMocks.message.count.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.direction === "OUTBOUND");
    expect(replyWhere).toMatchObject({ senderType: { in: ["AI", "HUMAN"] } });
    prismaMocks.conversation.count.mockResolvedValue(0);
    prismaMocks.booking.count.mockResolvedValue(0);
  });
});

describe("crm_desk card intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const ctx = { organisationId: "org_1", agentRunId: "run_1", agentStepId: "step_1" };

  it("pipeline_summary covers lead stages first, then deals", async () => {
    prismaMocks.pipelineStage.findMany.mockResolvedValueOnce(STAGES);
    prismaMocks.lead.groupBy.mockResolvedValueOnce(
      STAGE_COUNTS.map((c) => ({ stageId: c.stageId, _count: { _all: c.count } })),
    );
    prismaMocks.lead.findMany.mockResolvedValueOnce(LEADS);
    prismaMocks.deal.findMany.mockResolvedValueOnce([]);
    const { output } = await crmDeskAgent.execute(
      { intent: "pipeline_summary", request: "Summarise my pipeline" },
      ctx,
    );
    expect(output.source).toBe("internal_crm");
    expect(output.summary).toMatch(/^LEAD PIPELINE — 7 open leads/);
    expect(output.summary).toMatch(/STUCK \/ STALLED LEADS/);
    expect(output.summary).toMatch(/HOT LEADS/);
    expect(output.summary).toMatch(/No open deals — the lead pipeline above is your sales pipeline/);
    // New, Qualifying, Qualified + the "No stage yet" bucket hold open leads.
    expect(output.shortAnswer).toMatch(/7 open leads across 4 stages; 1 stalled; 1 hot\. No open deals\./);
    expect(output.leadPipeline?.openLeads).toBe(7);
    expect(output.operatorSections?.topPriorities.length).toBeGreaterThan(0);
  });

  it("objections intent answers from Objection rows", async () => {
    prismaMocks.objection.findMany.mockResolvedValueOnce([
      { category: "PRICE", text: "Too pricey", detectedAt: new Date(), conversation: null },
    ]);
    const { output, costCents } = await crmDeskAgent.execute(
      { intent: "objections", request: "Common objections this week" },
      ctx,
    );
    expect(costCents).toBe(0);
    expect(output.summary).toMatch(/1\. Price — 1 \(100%\)/);
    expect(output.shortAnswer).toMatch(/most common: Price \(1\)/);
    expect(prismaMocks.deal.findMany).not.toHaveBeenCalled();
  });

  it("dm_triage intent lists threads with next steps", async () => {
    prismaMocks.conversation.findMany.mockResolvedValueOnce([
      conv({ id: "Holly", needsHumanReview: true, lastMessagePreview: "Can I speak to someone?" }),
    ]);
    const { output } = await crmDeskAgent.execute({ intent: "dm_triage", request: "Help me handle DMs" }, ctx);
    expect(output.counts.conversationsNeedingHuman).toBe(1);
    expect(output.summary).toMatch(/1\. Holly — needs a human/);
    expect(output.operatorSections?.topPriorities[0]).toMatch(/^Holly: Reply personally/);
  });

  it("results_report intent compares two weeks", async () => {
    const { output } = await crmDeskAgent.execute({ intent: "results_report", request: "Weekly performance" }, ctx);
    expect(output.summary).toMatch(/^RESULTS — last 7 days/);
    expect(output.shortAnswer).toMatch(/^Last 7 days: 0 new conversations/);
  });
});
