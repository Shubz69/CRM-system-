import { z } from "zod";
import type { Agent } from "@/agents/types";
import { prisma } from "@/lib/db";
import { buildChiefOfStaffFacts } from "@/services/chief-of-staff";
import { retrieveRelevantKnowledge } from "@/services/knowledge";
import { getBusinessProfile } from "@/services/digital-twin";
import { buildBusinessEvidencePack } from "@/services/business-evidence-pack";

export const crmDeskInputSchema = z.object({
  intent: z.enum([
    "pipeline_summary",
    "follow_ups",
    "goals_at_risk",
    "conversations_needing_human",
    "content_awaiting_approval",
    "operator_brief",
    "business_context",
    "desk_overview",
  ]),
  request: z.string().max(4000).optional(),
});

export const crmDeskOutputSchema = z.object({
  shortAnswer: z.string(),
  summary: z.string(),
  source: z.literal("internal_crm"),
  organisationId: z.string(),
  counts: z.object({
    openDeals: z.number(),
    stalledDeals: z.number(),
    conversationsNeedingHuman: z.number(),
    conversationsNeedingReply: z.number(),
    goalsAtRisk: z.number(),
    contentAwaitingApproval: z.number(),
  }),
  deals: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      stageLabel: z.string().nullable(),
      amountCents: z.number().nullable(),
      updatedAt: z.string(),
      stalled: z.boolean(),
    }),
  ),
  conversations: z.array(
    z.object({
      id: z.string(),
      contactName: z.string().nullable(),
      needsHumanReview: z.boolean(),
      unreadCount: z.number(),
      lastMessageAt: z.string().nullable(),
    }),
  ),
  goals: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
    }),
  ),
  content: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      status: z.string(),
    }),
  ),
  operatorSections: z
    .object({
      topPriorities: z.array(z.string()),
      needsAttention: z.array(z.string()),
      sales: z.array(z.string()),
      pipelineRisk: z.array(z.string()),
      content: z.array(z.string()),
      automation: z.array(z.string()),
      goalsKpi: z.array(z.string()),
      ignore: z.array(z.string()),
      risks: z.array(z.string()),
      insufficientEvidence: z.array(z.string()),
    })
    .optional(),
});

export type CrmDeskInput = z.infer<typeof crmDeskInputSchema>;
export type CrmDeskOutput = z.infer<typeof crmDeskOutputSchema>;

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

function money(cents: number | null | undefined): string {
  if (cents == null) return "no amount";
  return `£${(cents / 100).toFixed(0)}`;
}

function buildOperatorBrief(input: {
  stalledDeals: Array<{ name: string; stageLabel: string | null; amountCents: number | null }>;
  dealRows: Array<{ name: string; stageLabel: string | null; amountCents: number | null; stalled: boolean }>;
  needingReply: Array<{ contactName: string | null; unreadCount: number }>;
  needingHuman: Array<{ contactName: string | null }>;
  goalsAtRisk: Array<{ name: string }>;
  activeGoals: Array<{ name: string; status: string }>;
  contentRows: Array<{ title: string | null }>;
  hotLeads: Array<{ name: string; score: number | null }>;
  opportunities: Array<{ title: string; why?: string }>;
  cosActions: Array<{ title: string; detail: string; why?: string }>;
  knowledgeHits: string[];
  contactCount: number;
  counts: CrmDeskOutput["counts"];
  request?: string;
}): { summary: string; shortAnswer: string; sections: NonNullable<CrmDeskOutput["operatorSections"]> } {
  const topPriorities: string[] = [];
  const needsAttention: string[] = [];
  const sales: string[] = [];
  const pipelineRisk: string[] = [];
  const content: string[] = [];
  const automation: string[] = [];
  const goalsKpi: string[] = [];
  const ignore: string[] = [];
  const risks: string[] = [];
  const insufficientEvidence: string[] = [];
  const req = (input.request || "").toLowerCase();

  const fmtRec = (parts: {
    what: string;
    why: string;
    evidence: string;
    urgency: string;
    next: string;
  }) =>
    [
      `WHAT: ${parts.what}`,
      `WHY: ${parts.why}`,
      `EVIDENCE: ${parts.evidence}`,
      `URGENCY: ${parts.urgency}`,
      `NEXT ACTION: ${parts.next}`,
    ].join(" · ");

  // Score 0 / null leads must never dominate TOP PRIORITIES.
  const rankedLeads = input.hotLeads.filter((l) => (l.score ?? 0) > 0);

  for (const c of input.needingReply.slice(0, 5)) {
    const who = c.contactName || "Unknown contact";
    const rec = fmtRec({
      what: `Reply to ${who}`,
      why: "Open conversation needs a human response",
      evidence: `Inbox unread=${c.unreadCount} / handoff flags`,
      urgency: "high",
      next: "Open Inbox → draft reply → send (human-reviewed)",
    });
    needsAttention.push(rec);
    topPriorities.push(rec);
  }
  for (const c of input.needingHuman.slice(0, 3)) {
    if (c.contactName && needsAttention.some((n) => n.includes(c.contactName!))) continue;
    needsAttention.push(
      fmtRec({
        what: `Take over conversation with ${c.contactName || "Unknown"}`,
        why: "Conversation marked needs-human",
        evidence: "needsHumanReview / HUMAN handling mode",
        urgency: "high",
        next: "Open Inbox and respond as human",
      }),
    );
  }

  if (
    /\b(reply|follow[- ]?up|inbox|customers? need)\b/.test(req) &&
    !input.needingReply.length &&
    !input.needingHuman.length
  ) {
    const rec = fmtRec({
      what: "No conversations currently need a reply",
      why: "Inbox has no unread/handoff queues right now",
      evidence: "conversationsNeedingReply=0 · conversationsNeedingHuman=0",
      urgency: "low",
      next: "Check Inbox later or ask about pipeline/goals instead",
    });
    needsAttention.push(rec);
    topPriorities.push(rec);
    insufficientEvidence.push(
      "No unanswered conversations in this workspace — cannot name a person who needs a reply.",
    );
  }

  for (const d of input.stalledDeals.slice(0, 5)) {
    const rec = fmtRec({
      what: `Unblock deal “${d.name}”`,
      why: `Stalled ≥14 days at ${d.stageLabel || "unknown stage"}`,
      evidence: `Quiet ≥14 days · ${money(d.amountCents)}`,
      urgency: "high",
      next: "Message the buyer or schedule a checkpoint this week",
    });
    sales.push(rec);
    pipelineRisk.push(rec);
    topPriorities.push(rec);
  }
  if (!input.stalledDeals.length && input.dealRows.length) {
    const top = input.dealRows[0]!;
    sales.push(
      fmtRec({
        what: `Advance “${top.name}”`,
        why: "Highest-urgency open deal (no ≥14-day stalls detected)",
        evidence: `${top.stageLabel || "no stage"} · ${money(top.amountCents)}`,
        urgency: "medium",
        next: "Confirm next stage action with the buyer",
      }),
    );
  }
  if (!input.dealRows.length) {
    insufficientEvidence.push("No open deals in this workspace — cannot prioritise a stuck deal.");
    pipelineRisk.push("INSUFFICIENT EVIDENCE: no open deals to score pipeline risk.");
  } else if (!input.stalledDeals.length) {
    pipelineRisk.push(
      "No deals quiet ≥14 days — pipeline stall risk currently low on workspace evidence.",
    );
  }

  for (const l of rankedLeads.slice(0, 3)) {
    const rec = fmtRec({
      what: `Focus lead ${l.name}`,
      why: "Highest scored open lead in CRM",
      evidence: `Lead score ${l.score}`,
      urgency: "medium",
      next: "Qualify or book from CRM Contacts/Leads",
    });
    sales.push(rec);
    if (
      topPriorities.length < 3 &&
      !input.needingReply.length &&
      !input.stalledDeals.length &&
      !input.goalsAtRisk.length
    ) {
      topPriorities.push(rec);
    }
  }
  if (!rankedLeads.length && !input.dealRows.length) {
    insufficientEvidence.push(
      "No positively scored open leads found — lead focus needs CRM lead scores > 0.",
    );
  }

  for (const o of input.opportunities.slice(0, 3)) {
    const rec = fmtRec({
      what: `Review opportunity “${o.title}”`,
      why: o.why || "Detector/priority signal in Opportunities",
      evidence: "Chief-of-staff / opportunity detector",
      urgency: "medium",
      next: "Open Opportunities and decide pursue / defer",
    });
    sales.push(rec);
    if (topPriorities.length < 5) topPriorities.push(rec);
  }

  for (const g of input.goalsAtRisk) {
    const rec = fmtRec({
      what: `Stabilise goal “${g.name}”`,
      why: "Goal status is AT_RISK",
      evidence: "Goals table status=AT_RISK",
      urgency: "high",
      next: "Check KPI targets on Goals and assign an owner action",
    });
    risks.push(rec);
    goalsKpi.push(rec);
    topPriorities.push(rec);
  }
  if (!input.goalsAtRisk.length && input.activeGoals.length) {
    goalsKpi.push(
      fmtRec({
        what: "Keep active goals on watch-only",
        why: "No AT_RISK goals in workspace",
        evidence: `Active: ${input.activeGoals
          .slice(0, 3)
          .map((g) => g.name)
          .join("; ")}`,
        urgency: "low",
        next: "Do not reopen unless a KPI alert appears",
      }),
    );
    ignore.push(
      `Active goals look stable (${input.activeGoals
        .slice(0, 3)
        .map((g) => g.name)
        .join("; ")}) — do not reopen them today unless a KPI alert appears.`,
    );
  }
  if (!input.activeGoals.length && !input.goalsAtRisk.length) {
    insufficientEvidence.push("No active/at-risk goals — KPI attention not evidenced.");
    goalsKpi.push("INSUFFICIENT EVIDENCE: no active/at-risk goals or KPI rows to prioritise.");
  }

  for (const p of input.contentRows.slice(0, 3)) {
    const rec = fmtRec({
      what: `Approve or revise “${p.title || "Untitled draft"}”`,
      why: "Content currently in review / awaiting approval",
      evidence: "Content OS status IN_REVIEW or pending approval",
      urgency: "medium",
      next: "Open Content → approve, revise, or reject",
    });
    content.push(rec);
    if (topPriorities.length < 5) topPriorities.push(rec);
  }
  if (!input.contentRows.length) {
    if (input.hotLeads[0] || input.stalledDeals[0]) {
      content.push(
        fmtRec({
          what: "Optional: short follow-up post for today's priority lead/deal",
          why: "No drafts awaiting approval; outbound content is optional",
          evidence: "Content queue empty",
          urgency: "low",
          next: "Only create if you want outbound content today",
        }),
      );
    } else {
      insufficientEvidence.push("No content in review — no evidence-backed content recommendation.");
    }
  }

  if (input.needingReply.length >= 2) {
    automation.push(
      fmtRec({
        what: "Automate notify + draft reply on unread/handoff rise",
        why: "Repeated inbox friction (≥2 needing reply)",
        evidence: `${input.needingReply.length} conversations needing reply`,
        urgency: "medium",
        next: "Create automation draft with human-review gate (never auto-send)",
      }),
    );
  } else if (input.stalledDeals.length >= 2) {
    automation.push(
      fmtRec({
        what: "Automate stall alert for open deals quiet ≥14 days",
        why: "Repeated pipeline stall pattern",
        evidence: `${input.stalledDeals.length} stalled deals`,
        urgency: "medium",
        next: "Create automation draft: alert owner when quiet ≥14 days",
      }),
    );
  } else if (/\bautomate\b/.test(req)) {
    automation.push(
      fmtRec({
        what: "No high-confidence automation yet",
        why: "Not enough repeated friction in inbox or pipeline",
        evidence: `needingReply=${input.needingReply.length} · stalledDeals=${input.stalledDeals.length}`,
        urgency: "low",
        next: "Revisit after 2+ similar handoffs or stalls appear",
      }),
    );
    insufficientEvidence.push(
      "Not enough repeated friction yet to recommend a high-confidence automation — avoid inventing one.",
    );
  } else {
    insufficientEvidence.push(
      "Not enough repeated friction yet to recommend a high-confidence automation — avoid inventing one.",
    );
  }

  for (const a of input.cosActions.slice(0, 3)) {
    if (topPriorities.length >= 5) break;
    topPriorities.push(
      fmtRec({
        what: a.title,
        why: a.why || "Chief-of-staff recommended action",
        evidence: a.detail,
        urgency: "medium",
        next: a.detail,
      }),
    );
  }

  if (input.contactCount > 50 && input.counts.conversationsNeedingReply === 0 && !input.stalledDeals.length) {
    ignore.push(
      fmtRec({
        what: "Skip bulk contact cleanup today",
        why: "Inbox quiet and pipeline not stalled",
        evidence: `${input.contactCount} contacts · 0 needing reply · 0 stalls`,
        urgency: "low",
        next: "Deprioritise CRM hygiene work today",
      }),
    );
  }
  if (!ignore.length) {
    ignore.push(
      fmtRec({
        what: "Deprioritise speculative busywork",
        why: "No evidence it moves pipeline, inbox, or goals today",
        evidence: "Operator brief scan",
        urgency: "low",
        next: "Stay on TOP PRIORITIES only",
      }),
    );
  }

  if (input.knowledgeHits.length) {
    needsAttention.push(
      `Workspace knowledge matched this ask: ${input.knowledgeHits.slice(0, 2).join(" | ")}`,
    );
  }

  if (!topPriorities.length) {
    topPriorities.push(
      fmtRec({
        what: "Add one real pipeline deal or clear Business Profile gaps",
        why: "No urgent CRM fires detected",
        evidence: "Empty stall/handoff queues · no positive lead scores",
        urgency: "low",
        next: "Create one deal or update Business Profile",
      }),
    );
    insufficientEvidence.push("Sparse operational signal — priorities are provisional.");
  }

  if (/\bautomate\b/.test(req) && automation[0]) {
    topPriorities.unshift(automation[0]);
  }
  if (/\b(kpi|goal)\b/.test(req) && goalsKpi[0]) {
    topPriorities.unshift(goalsKpi[0]);
  }
  if (/\b(content|create|draft)\b/.test(req) && content[0]) {
    topPriorities.unshift(content[0]);
  }

  const sections = {
    topPriorities: [...new Set(topPriorities)].slice(0, 6),
    needsAttention,
    sales,
    pipelineRisk,
    content,
    automation,
    goalsKpi,
    ignore,
    risks,
    insufficientEvidence: [...new Set(insufficientEvidence)],
  };

  const blocks: string[] = ["TOP PRIORITIES"];
  sections.topPriorities.slice(0, 5).forEach((p, i) => {
    blocks.push(`${i + 1}. ${p}`);
  });
  if (needsAttention.length) {
    blocks.push("", "NEEDS ATTENTION", ...needsAttention.slice(0, 5).map((x) => `• ${x}`));
  }
  if (sales.length) {
    blocks.push("", "SALES", ...sales.slice(0, 5).map((x) => `• ${x}`));
  }
  if (pipelineRisk.length) {
    blocks.push("", "PIPELINE RISK", ...pipelineRisk.slice(0, 5).map((x) => `• ${x}`));
  }
  if (content.length) {
    blocks.push("", "CONTENT", ...content.slice(0, 3).map((x) => `• ${x}`));
  }
  if (automation.length) {
    blocks.push("", "AUTOMATION", ...automation.slice(0, 2).map((x) => `• ${x}`));
  }
  if (goalsKpi.length) {
    blocks.push("", "GOALS/KPI", ...goalsKpi.slice(0, 4).map((x) => `• ${x}`));
  }
  if (ignore.length) {
    blocks.push("", "IGNORE / DEPRIORITISE", ...ignore.slice(0, 3).map((x) => `• ${x}`));
  }
  if (risks.length) {
    blocks.push("", "RISKS / BLOCKERS", ...risks.slice(0, 3).map((x) => `• ${x}`));
  }
  if (insufficientEvidence.length) {
    blocks.push(
      "",
      "INSUFFICIENT EVIDENCE",
      ...insufficientEvidence.slice(0, 4).map((x) => `• ${x}`),
    );
  }

  const summary = blocks.join("\n");
  const shortAnswer = sections.topPriorities[0] || summary.slice(0, 280);
  return { summary, shortAnswer, sections };
}

/**
 * Internal CRM desk agent — org-scoped Prisma reads only. Never web research / echo.
 */
export const crmDeskAgent: Agent<CrmDeskInput, CrmDeskOutput> = {
  name: "crm_desk",
  description:
    "Summarises this workspace’s pipeline, handoffs, goals at risk, and content awaiting approval from internal CRM data.",
  inputSchema: crmDeskInputSchema,
  outputSchema: crmDeskOutputSchema,
  tier: "cheap",
  estimateCostCents: () => 0,
  userFacingLabel: (input) => {
    switch (input.intent) {
      case "pipeline_summary":
        return "Reading open deals and stalled pipeline stages";
      case "follow_ups":
        return "Checking conversations that need a reply";
      case "goals_at_risk":
        return "Checking goals marked at risk";
      case "conversations_needing_human":
        return "Listing conversations that need a human";
      case "content_awaiting_approval":
        return "Listing content waiting for approval";
      case "operator_brief":
        return "Building your prioritised operator brief from workspace data";
      case "business_context":
        return "Reading your Business Profile / business context";
      default:
        return "Reading your CRM desk from workspace data";
    }
  },
  async execute(input, ctx) {
    const parsed = crmDeskInputSchema.parse({
      intent: input.intent || "desk_overview",
      request: input.request,
    });
    const orgId = ctx.organisationId;
    const now = Date.now();
    const intent = parsed.intent;
    const req = (parsed.request || "").toLowerCase();

    if (intent === "business_context") {
      const profile = await getBusinessProfile(orgId).catch(() => null);
      const products = (profile?.products || [])
        .slice(0, 5)
        .map((p: { name?: string | null }) => p.name)
        .filter(Boolean) as string[];
      const audiences = (profile?.audiences || [])
        .slice(0, 5)
        .map((a: { name?: string | null }) => a.name)
        .filter(Boolean) as string[];
      const claims = (profile?.claims || [])
        .slice(0, 6)
        .map((c: { predicate?: string | null; valueText?: string | null }) => {
          const pred = c.predicate?.trim();
          const val = c.valueText?.replace(/\s+/g, " ").trim();
          if (pred && val) return `${pred}: ${val}`.slice(0, 160);
          return (val || pred || "").slice(0, 160);
        })
        .filter(Boolean);
      const orgName = profile?.organisation?.name || "This workspace";
      const lines: string[] = [
        `Business context for ${orgName} (organisation-scoped Business Profile).`,
      ];
      if (products.length) lines.push(`What we sell / offer: ${products.join("; ")}.`);
      else lines.push("No active product offerings recorded in Business Profile yet.");
      if (audiences.length) lines.push(`Audiences: ${audiences.join("; ")}.`);
      if (claims.length) lines.push(`Known claims: ${claims.join(" | ")}.`);
      if (!products.length && !audiences.length && !claims.length) {
        lines.push(
          "INSUFFICIENT EVIDENCE: Business Profile is sparse — fill Business Context before answering external positioning questions.",
        );
      }
      const summary = lines.join(" ");
      return {
        output: {
          shortAnswer: products.length
            ? `${orgName} offers: ${products.slice(0, 3).join("; ")}.`
            : summary.slice(0, 280),
          summary,
          source: "internal_crm" as const,
          organisationId: orgId,
          counts: {
            openDeals: 0,
            stalledDeals: 0,
            conversationsNeedingHuman: 0,
            conversationsNeedingReply: 0,
            goalsAtRisk: 0,
            contentAwaitingApproval: 0,
          },
          deals: [],
          conversations: [],
          goals: [],
          content: [],
        },
        costCents: 0,
      };
    }

    const contactFocused =
      /\bhow many\s+contacts?\b/.test(req) ||
      /\b(list|show|newest|name)\b.*\bcontacts?\b/.test(req) ||
      /\bmy\s+(\w+\s+){0,2}contacts?\b/.test(req);
    const contactList =
      contactFocused &&
      /\b(list|show|newest|name)\b/.test(req) &&
      !/\bhow many\b/.test(req);
    const companyFocused =
      /\bhow many\s+compan(?:y|ies)\b/.test(req) ||
      /\b(list|name|show)\b.*\bcompan(?:y|ies)\b/.test(req);
    const companyList =
      companyFocused &&
      /\b(list|show|newest|name)\b/.test(req) &&
      !/\bhow many\b/.test(req);
    const needDeals =
      !contactFocused &&
      !companyFocused &&
      (intent === "pipeline_summary" ||
        intent === "desk_overview" ||
        intent === "operator_brief");
    const needConversations =
      !contactFocused &&
      !companyFocused &&
      (intent === "follow_ups" ||
        intent === "conversations_needing_human" ||
        intent === "desk_overview" ||
        intent === "operator_brief");
    const needGoals =
      !contactFocused &&
      !companyFocused &&
      (intent === "goals_at_risk" || intent === "desk_overview" || intent === "operator_brief");
    const needContent =
      !contactFocused &&
      !companyFocused &&
      (intent === "content_awaiting_approval" ||
        intent === "desk_overview" ||
        intent === "operator_brief");
    const needLeads =
      !contactFocused &&
      !companyFocused &&
      (intent === "operator_brief" || intent === "desk_overview");
    const needContacts = contactFocused || intent === "desk_overview" || intent === "operator_brief";
    const needApprovals = needContent;
    const companyCountPromise = companyFocused
      ? prisma.company.count({ where: { organisationId: orgId, deletedAt: null } }).catch(() => 0)
      : Promise.resolve(null as number | null);

    const operatorBriefPromise =
      intent === "operator_brief"
        ? Promise.all([
            buildChiefOfStaffFacts(orgId).catch(() => null),
            parsed.request
              ? retrieveRelevantKnowledge({
                  organisationId: orgId,
                  query: parsed.request,
                  limit: 4,
                }).catch(() => null)
              : Promise.resolve(null),
            buildBusinessEvidencePack(orgId).catch(() => null),
          ])
        : null;

    type DealRow = {
      id: string;
      name: string;
      status: string;
      stageLabel: string | null;
      amountCents: number | null;
      updatedAt: Date;
    };
    type ConvRow = {
      id: string;
      needsHumanReview: boolean;
      handlingMode: string;
      unreadCount: number | null;
      lastMessageAt: Date | null;
      contact: { fullName: string | null; instagramUsername: string | null } | null;
    };
    type GoalRow = { id: string; name: string; status: string };
    type ContentRow = { id: string; title: string | null; status: string };
    type LeadRow = {
      id: string;
      score: number | null;
      contact: { fullName: string | null } | null;
    };
    type ApprovalRow = { id: string; kind: string; title: string | null };

    const emptyDeals: DealRow[] = [];
    const emptyConv: ConvRow[] = [];
    const emptyGoals: GoalRow[] = [];
    const emptyContent: ContentRow[] = [];
    const emptyLeads: LeadRow[] = [];
    const emptyApprovals: ApprovalRow[] = [];

    const [deals, conversations, goals, contentPieces, hotLeads, contactCount, pendingApprovals, companyCount] =
      await Promise.all([
        needDeals
          ? prisma.deal.findMany({
              where: { organisationId: orgId, deletedAt: null, status: "OPEN" },
              orderBy: { updatedAt: "asc" },
              take: 40,
              select: {
                id: true,
                name: true,
                status: true,
                stageLabel: true,
                amountCents: true,
                updatedAt: true,
              },
            })
          : Promise.resolve(emptyDeals),
        needConversations
          ? prisma.conversation.findMany({
              where: { organisationId: orgId, deletedAt: null },
              orderBy: { updatedAt: "desc" },
              take: intent === "operator_brief" ? 60 : 40,
              select: {
                id: true,
                needsHumanReview: true,
                handlingMode: true,
                unreadCount: true,
                lastMessageAt: true,
                contact: { select: { fullName: true, instagramUsername: true } },
              },
            })
          : Promise.resolve(emptyConv),
        needGoals
          ? prisma.goal.findMany({
              where: { organisationId: orgId, status: { in: ["AT_RISK", "ACTIVE"] } },
              orderBy: { updatedAt: "desc" },
              take: 20,
              select: { id: true, name: true, status: true },
            })
          : Promise.resolve(emptyGoals),
        needContent
          ? prisma.contentPiece.findMany({
              where: {
                organisationId: orgId,
                status: "IN_REVIEW",
              },
              orderBy: { updatedAt: "desc" },
              take: 20,
              select: { id: true, title: true, status: true },
            })
          : Promise.resolve(emptyContent),
        needLeads
          ? prisma.lead
              .findMany({
                where: {
                  organisationId: orgId,
                  deletedAt: null,
                },
                orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
                take: 8,
                select: {
                  id: true,
                  score: true,
                  contact: { select: { fullName: true } },
                },
              })
              .catch(() => emptyLeads)
          : Promise.resolve(emptyLeads),
        needContacts
          ? prisma.contact.count({
              where: { organisationId: orgId, deletedAt: null },
            })
          : Promise.resolve(0),
        needApprovals
          ? prisma.approvalRequest
              .findMany({
                where: { organisationId: orgId, status: "PENDING" },
                take: 20,
                orderBy: { createdAt: "desc" },
                select: { id: true, kind: true, title: true },
              })
              .catch(() => emptyApprovals)
          : Promise.resolve(emptyApprovals),
        companyCountPromise,
      ]);

    if (contactFocused) {
      if (contactList) {
        const newest = await prisma.contact.findMany({
          where: { organisationId: orgId, deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 8,
          select: { fullName: true, email: true, createdAt: true },
        });
        const names = newest
          .map((c) => c.fullName || c.email || "Unnamed contact")
          .filter(Boolean);
        const summary =
          names.length === 0
            ? `This workspace has ${contactCount} contacts, but none are listable yet.`
            : `Newest contacts (${contactCount} total): ${names.join("; ")}.`;
        return {
          output: {
            shortAnswer: summary.slice(0, 280),
            summary,
            source: "internal_crm" as const,
            organisationId: orgId,
            counts: {
              openDeals: 0,
              stalledDeals: 0,
              conversationsNeedingHuman: 0,
              conversationsNeedingReply: 0,
              goalsAtRisk: 0,
              contentAwaitingApproval: 0,
            },
            deals: [],
            conversations: [],
            goals: [],
            content: [],
          },
          costCents: 0,
        };
      }
      const summary = `This workspace has ${contactCount} contact${contactCount === 1 ? "" : "s"} (organisation-scoped count).`;
      return {
        output: {
          shortAnswer: summary,
          summary,
          source: "internal_crm" as const,
          organisationId: orgId,
          counts: {
            openDeals: 0,
            stalledDeals: 0,
            conversationsNeedingHuman: 0,
            conversationsNeedingReply: 0,
            goalsAtRisk: 0,
            contentAwaitingApproval: 0,
          },
          deals: [],
          conversations: [],
          goals: [],
          content: [],
        },
        costCents: 0,
      };
    }
    if (companyFocused) {
      if (companyList) {
        const newest = await prisma.company.findMany({
          where: { organisationId: orgId, deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 8,
          select: { name: true, createdAt: true },
        });
        const n = companyCount ?? newest.length;
        const names = newest.map((c) => c.name).filter(Boolean);
        const summary =
          names.length === 0
            ? `This workspace has ${n} companies, but none are listable yet.`
            : `Companies (${n} total): ${names.join("; ")}.`;
        return {
          output: {
            shortAnswer: summary.slice(0, 280),
            summary,
            source: "internal_crm" as const,
            organisationId: orgId,
            counts: {
              openDeals: 0,
              stalledDeals: 0,
              conversationsNeedingHuman: 0,
              conversationsNeedingReply: 0,
              goalsAtRisk: 0,
              contentAwaitingApproval: 0,
            },
            deals: [],
            conversations: [],
            goals: [],
            content: [],
          },
          costCents: 0,
        };
      }
      const n = companyCount ?? 0;
      const summary = `This workspace has ${n} compan${n === 1 ? "y" : "ies"} (organisation-scoped count).`;
      return {
        output: {
          shortAnswer: summary,
          summary,
          source: "internal_crm" as const,
          organisationId: orgId,
          counts: {
            openDeals: 0,
            stalledDeals: 0,
            conversationsNeedingHuman: 0,
            conversationsNeedingReply: 0,
            goalsAtRisk: 0,
            contentAwaitingApproval: 0,
          },
          deals: [],
          conversations: [],
          goals: [],
          content: [],
        },
        costCents: 0,
      };
    }

    const dealRows = deals.map((d) => {
      const stalled = now - d.updatedAt.getTime() >= STALE_MS;
      return {
        id: d.id,
        name: d.name,
        status: d.status,
        stageLabel: d.stageLabel,
        amountCents: d.amountCents,
        updatedAt: d.updatedAt.toISOString(),
        stalled,
      };
    });
    const stalledDeals = dealRows.filter((d) => d.stalled);

    const needingHuman = conversations.filter(
      (c) => c.needsHumanReview || c.handlingMode === "HUMAN",
    );
    const needingReply = conversations.filter(
      (c) => (c.unreadCount ?? 0) > 0 || c.needsHumanReview,
    );

    const goalsAtRisk = goals.filter((g) => g.status === "AT_RISK");

    let contentRows = contentPieces.map((p) => ({
      id: p.id,
      title: p.title,
      status: String(p.status),
    }));

    if (!contentRows.length && pendingApprovals.length) {
      contentRows = pendingApprovals.map((a) => ({
        id: a.id,
        title: a.title || `${a.kind || "Item"} awaiting approval`,
        status: "PENDING",
      }));
    }

    const counts = {
      openDeals: dealRows.length,
      stalledDeals: stalledDeals.length,
      conversationsNeedingHuman: needingHuman.length,
      conversationsNeedingReply: needingReply.length,
      goalsAtRisk: goalsAtRisk.length,
      contentAwaitingApproval: contentRows.length,
    };

    const convRows = needingReply.slice(0, 12).map((c) => ({
      id: c.id,
      contactName: c.contact?.fullName || c.contact?.instagramUsername || null,
      needsHumanReview: Boolean(c.needsHumanReview),
      unreadCount: c.unreadCount ?? 0,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    }));

    if (parsed.intent === "operator_brief") {
      const [cos, knowledge, evidencePack] = (await operatorBriefPromise) ?? [null, null, null];

      const opportunities = (cos?.sections.OPPORTUNITIES || []).slice(0, 5).map((o) => ({
        title: o.title,
        why: o.why || o.detail,
      }));
      const cosActions = [
        ...(cos?.sections.RECOMMENDED_ACTIONS || []),
        ...(cos?.sections.WAITING_FOR_YOU || []),
      ].map((a) => ({
        title: a.title,
        detail: a.detail,
        why: a.why,
      }));

      const brief = buildOperatorBrief({
        stalledDeals,
        dealRows,
        needingReply: convRows,
        needingHuman: needingHuman.map((c) => ({
          contactName: c.contact?.fullName || c.contact?.instagramUsername || null,
        })),
        goalsAtRisk,
        activeGoals: goals.filter((g) => g.status === "ACTIVE"),
        contentRows,
        hotLeads: hotLeads.map((l) => ({
          name: l.contact?.fullName || "Lead",
          score: l.score,
        })),
        opportunities,
        cosActions,
        knowledgeHits: (knowledge?.chunks || [])
          .slice(0, 3)
          .map((c) => c.replace(/\s+/g, " ").trim().slice(0, 160))
          .filter(Boolean),
        contactCount,
        counts,
        request: parsed.request,
      });

      const evidenceFooter =
        evidencePack?.summaryLines?.length
          ? `\n\nEVIDENCE PACK\n${evidencePack.summaryLines.join("\n")}`
          : "";

      return {
        output: {
          shortAnswer: brief.shortAnswer,
          summary: `${brief.summary}${evidenceFooter}`,
          source: "internal_crm" as const,
          organisationId: orgId,
          counts,
          deals: dealRows.slice(0, 12),
          conversations: convRows,
          goals: goals.map((g) => ({ id: g.id, name: g.name, status: g.status })),
          content: contentRows.slice(0, 12),
          operatorSections: brief.sections,
        },
        costCents: 0,
      };
    }

    const lines: string[] = [];
    if (
      parsed.intent === "pipeline_summary" ||
      parsed.intent === "desk_overview" ||
      parsed.intent === "follow_ups"
    ) {
      lines.push(
        `Open deals: ${counts.openDeals}. Stalled (≥14 days quiet): ${counts.stalledDeals}.`,
      );
      if (stalledDeals.length) {
        lines.push(
          "Stalled deals: " +
            stalledDeals
              .slice(0, 5)
              .map((d) => `${d.name} (${d.stageLabel || "no stage"}, ${money(d.amountCents)})`)
              .join("; ") +
            ".",
        );
      } else if (dealRows.length) {
        lines.push(
          "Active deals: " +
            dealRows
              .slice(0, 5)
              .map((d) => `${d.name} (${d.stageLabel || "no stage"})`)
              .join("; ") +
            ".",
        );
      } else {
        lines.push("No open deals in this workspace yet.");
      }
    }

    if (
      parsed.intent === "conversations_needing_human" ||
      parsed.intent === "follow_ups" ||
      parsed.intent === "desk_overview"
    ) {
      lines.push(
        `Conversations needing a human: ${counts.conversationsNeedingHuman}. Needing reply (unread or handoff): ${counts.conversationsNeedingReply}.`,
      );
      if (convRows.length) {
        lines.push(
          "Who needs a reply: " +
            convRows
              .slice(0, 5)
              .map((c) => c.contactName || "Unknown")
              .join("; ") +
            ".",
        );
      }
    }

    if (parsed.intent === "goals_at_risk" || parsed.intent === "desk_overview") {
      if (goalsAtRisk.length) {
        lines.push(
          `Goals at risk: ${goalsAtRisk.map((g) => g.name).join("; ")}.`,
        );
      } else {
        lines.push("No goals currently marked at risk.");
      }
    }

    if (parsed.intent === "content_awaiting_approval" || parsed.intent === "desk_overview") {
      lines.push(`Content / approvals waiting: ${counts.contentAwaitingApproval}.`);
    }

    const summary = lines.join(" ");
    const shortAnswer =
      parsed.intent === "pipeline_summary"
        ? counts.openDeals === 0
          ? "You have no open deals in this workspace."
          : `${counts.openDeals} open deal${counts.openDeals === 1 ? "" : "s"}; ${counts.stalledDeals} stalled.`
        : summary.slice(0, 280);

    return {
      output: {
        shortAnswer,
        summary,
        source: "internal_crm" as const,
        organisationId: orgId,
        counts,
        deals: dealRows.slice(0, 12),
        conversations: convRows,
        goals: goals.map((g) => ({ id: g.id, name: g.name, status: g.status })),
        content: contentRows.slice(0, 12),
      },
      costCents: 0,
    };
  },
};
