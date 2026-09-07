import { z } from "zod";
import type { Agent } from "@/agents/types";
import { prisma } from "@/lib/db";
import { buildChiefOfStaffFacts } from "@/services/chief-of-staff";
import { retrieveRelevantKnowledge } from "@/services/knowledge";

export const crmDeskInputSchema = z.object({
  intent: z.enum([
    "pipeline_summary",
    "follow_ups",
    "goals_at_risk",
    "conversations_needing_human",
    "content_awaiting_approval",
    "operator_brief",
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
      content: z.array(z.string()),
      automation: z.array(z.string()),
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
}): { summary: string; shortAnswer: string; sections: NonNullable<CrmDeskOutput["operatorSections"]> } {
  const topPriorities: string[] = [];
  const needsAttention: string[] = [];
  const sales: string[] = [];
  const content: string[] = [];
  const automation: string[] = [];
  const ignore: string[] = [];
  const risks: string[] = [];
  const insufficientEvidence: string[] = [];

  for (const c of input.needingReply.slice(0, 5)) {
    const who = c.contactName || "Unknown contact";
    needsAttention.push(
      `${who} — unread/handoff (unread ${c.unreadCount}). Urgency: high while unread.`,
    );
    topPriorities.push(
      [
        `Reply to ${who}`,
        `Why: open conversation needs a human response`,
        `Evidence: Inbox unread=${c.unreadCount} / handoff flags`,
        `Next: open Inbox → draft reply → send (human-reviewed)`,
      ].join(" · "),
    );
  }
  for (const c of input.needingHuman.slice(0, 3)) {
    if (c.contactName && needsAttention.some((n) => n.includes(c.contactName!))) continue;
    needsAttention.push(
      `${c.contactName || "Conversation"} marked needs-human — take over in Inbox.`,
    );
  }

  for (const d of input.stalledDeals.slice(0, 5)) {
    sales.push(
      `Stuck deal: ${d.name} (${d.stageLabel || "no stage"}, ${money(d.amountCents)}) — quiet ≥14 days. Why now: stall risk. Next: reopen with a concrete follow-up.`,
    );
    topPriorities.push(
      [
        `Unblock ${d.name}`,
        `Why: stalled ≥14 days at ${d.stageLabel || "unknown stage"}`,
        `Evidence: deal last activity quiet ≥14 days (${money(d.amountCents)})`,
        `Next: message the buyer or schedule a checkpoint this week`,
      ].join(" · "),
    );
  }
  if (!input.stalledDeals.length && input.dealRows.length) {
    const top = input.dealRows[0]!;
    sales.push(
      `Focus deal: ${top.name} (${top.stageLabel || "no stage"}, ${money(top.amountCents)}). No deals are stalled ≥14 days.`,
    );
  }
  if (!input.dealRows.length) {
    insufficientEvidence.push("No open deals in this workspace — cannot prioritise a stuck deal.");
  }

  for (const l of input.hotLeads.slice(0, 3)) {
    sales.push(
      `Lead to focus: ${l.name}${l.score != null ? ` (score ${l.score})` : ""}. Next: qualify or book from CRM.`,
    );
    if (topPriorities.length < 5) {
      topPriorities.push(
        `Focus lead ${l.name}${l.score != null ? ` (score ${l.score})` : ""} — highest scored open lead evidence.`,
      );
    }
  }
  if (!input.hotLeads.length && !input.dealRows.length) {
    insufficientEvidence.push("No scored open leads found — lead focus needs CRM lead data.");
  }

  for (const o of input.opportunities.slice(0, 3)) {
    sales.push(
      `Opportunity: ${o.title}${o.why ? ` — ${o.why}` : ""}. Review on Opportunities.`,
    );
    if (topPriorities.length < 5) {
      topPriorities.push(`Review opportunity “${o.title}” — detector/priority evidence attached.`);
    }
  }

  for (const g of input.goalsAtRisk) {
    risks.push(`Goal at risk: ${g.name}. Check KPI targets on Goals.`);
    topPriorities.push(`Stabilise goal “${g.name}” — status AT_RISK.`);
  }
  if (!input.goalsAtRisk.length && input.activeGoals.length) {
    ignore.push(
      `Active goals look stable (${input.activeGoals
        .slice(0, 3)
        .map((g) => g.name)
        .join("; ")}) — do not reopen them today unless a KPI alert appears.`,
    );
  }
  if (!input.activeGoals.length && !input.goalsAtRisk.length) {
    insufficientEvidence.push("No active/at-risk goals — KPI attention not evidenced.");
  }

  for (const p of input.contentRows.slice(0, 3)) {
    content.push(
      `Approve or revise “${p.title || "Untitled draft"}” — currently in review.`,
    );
    if (topPriorities.length < 5) {
      topPriorities.push(
        `Clear content approval: “${p.title || "Untitled"}” waiting in Content OS.`,
      );
    }
  }
  if (!input.contentRows.length) {
    if (input.hotLeads[0] || input.stalledDeals[0]) {
      content.push(
        "No drafts awaiting approval. Useful next piece: a short follow-up post aimed at the lead/deal you prioritise today — only if you want outbound content.",
      );
    } else {
      insufficientEvidence.push("No content in review — no evidence-backed content recommendation.");
    }
  }

  if (input.needingReply.length >= 2) {
    automation.push(
      "Automate: notify + draft reply when unread/handoff rises (keep human review — never auto-send).",
    );
  } else if (input.stalledDeals.length >= 2) {
    automation.push(
      "Automate: alert when an open deal is quiet ≥14 days so stall does not go unnoticed.",
    );
  } else {
    insufficientEvidence.push(
      "Not enough repeated friction yet to recommend a high-confidence automation — avoid inventing one.",
    );
  }

  for (const a of input.cosActions.slice(0, 3)) {
    if (topPriorities.length >= 5) break;
    topPriorities.push(`${a.title}: ${a.detail}${a.why ? ` (${a.why})` : ""}`);
  }

  if (input.contactCount > 50 && input.counts.conversationsNeedingReply === 0 && !input.stalledDeals.length) {
    ignore.push(
      `Do not spend today on bulk contact cleanup (${input.contactCount} contacts, inbox quiet, pipeline not stalled).`,
    );
  }

  if (input.knowledgeHits.length) {
    needsAttention.push(
      `Workspace knowledge matched this ask: ${input.knowledgeHits.slice(0, 2).join(" | ")}`,
    );
  }

  if (!topPriorities.length) {
    topPriorities.push(
      "No urgent CRM fires detected. Use the day to add one real pipeline deal or clear Business Profile gaps — evidence: empty stall/handoff queues.",
    );
    insufficientEvidence.push("Sparse operational signal — priorities are provisional.");
  }

  const sections = {
    topPriorities,
    needsAttention,
    sales,
    content,
    automation,
    ignore,
    risks,
    insufficientEvidence,
  };

  const blocks: string[] = ["TOP PRIORITIES"];
  topPriorities.slice(0, 5).forEach((p, i) => {
    blocks.push(`${i + 1}. ${p}`);
  });
  if (needsAttention.length) {
    blocks.push("", "NEEDS ATTENTION", ...needsAttention.slice(0, 5).map((x) => `• ${x}`));
  }
  if (sales.length) {
    blocks.push("", "SALES", ...sales.slice(0, 5).map((x) => `• ${x}`));
  }
  if (content.length) {
    blocks.push("", "CONTENT", ...content.slice(0, 3).map((x) => `• ${x}`));
  }
  if (automation.length) {
    blocks.push("", "AUTOMATION", ...automation.slice(0, 2).map((x) => `• ${x}`));
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
  const shortAnswer = topPriorities[0] || summary.slice(0, 280);
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

    const operatorBriefPromise =
      parsed.intent === "operator_brief"
        ? Promise.all([
            buildChiefOfStaffFacts(orgId).catch(() => null),
            parsed.request
              ? retrieveRelevantKnowledge({
                  organisationId: orgId,
                  query: parsed.request,
                  limit: 4,
                }).catch(() => null)
              : Promise.resolve(null),
          ])
        : null;

    const [deals, conversations, goals, contentPieces, hotLeads, contactCount, pendingApprovals] =
      await Promise.all([
        prisma.deal.findMany({
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
        }),
        prisma.conversation.findMany({
          where: { organisationId: orgId, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 60,
          select: {
            id: true,
            needsHumanReview: true,
            handlingMode: true,
            unreadCount: true,
            lastMessageAt: true,
            contact: { select: { fullName: true, instagramUsername: true } },
          },
        }),
        prisma.goal.findMany({
          where: { organisationId: orgId, status: { in: ["AT_RISK", "ACTIVE"] } },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { id: true, name: true, status: true },
        }),
        prisma.contentPiece.findMany({
          where: {
            organisationId: orgId,
            status: "IN_REVIEW",
          },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { id: true, title: true, status: true },
        }),
        prisma.lead.findMany({
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
        }).catch(() => []),
        prisma.contact.count({
          where: { organisationId: orgId, deletedAt: null },
        }),
        prisma.approvalRequest
          .findMany({
            where: { organisationId: orgId, status: "PENDING" },
            take: 20,
            orderBy: { createdAt: "desc" },
            select: { id: true, kind: true, title: true },
          })
          .catch(() => []),
      ]);

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
      const [cos, knowledge] = (await operatorBriefPromise) ?? [null, null];

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
      });

      return {
        output: {
          shortAnswer: brief.shortAnswer,
          summary: brief.summary,
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
