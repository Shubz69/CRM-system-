import { z } from "zod";
import type { Agent } from "@/agents/types";
import { prisma } from "@/lib/db";

export const crmDeskInputSchema = z.object({
  intent: z.enum([
    "pipeline_summary",
    "follow_ups",
    "goals_at_risk",
    "conversations_needing_human",
    "content_awaiting_approval",
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
});

export type CrmDeskInput = z.infer<typeof crmDeskInputSchema>;
export type CrmDeskOutput = z.infer<typeof crmDeskOutputSchema>;

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

function money(cents: number | null | undefined): string {
  if (cents == null) return "no amount";
  return `£${(cents / 100).toFixed(0)}`;
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

    const [deals, conversations, goals, contentPieces] = await Promise.all([
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
    ]);

    const pendingApprovals = await prisma.approvalRequest
      .findMany({
        where: { organisationId: orgId, status: "PENDING" },
        take: 20,
        orderBy: { createdAt: "desc" },
        select: { id: true, kind: true, title: true },
      })
      .catch(() => []);

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
        deals: dealRows,
        conversations: needingReply.slice(0, 15).map((c) => ({
          id: c.id,
          contactName: c.contact.fullName || c.contact.instagramUsername,
          needsHumanReview: c.needsHumanReview,
          unreadCount: c.unreadCount ?? 0,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        })),
        goals: goalsAtRisk.map((g) => ({
          id: g.id,
          name: g.name,
          status: g.status,
        })),
        content: contentRows.slice(0, 15),
      },
      costCents: 0,
    };
  },
};
