/**
 * Workspace-data builders for the Ask page cards that answer from this
 * organisation's own CRM (never web research):
 *
 * - lead pipeline summary (Lead / PipelineStage — for DM-led businesses the lead
 *   pipeline IS the pipeline): counts per stage, stalled leads, hot leads, next actions
 * - DM triage: conversations that need a reply or a human, with a suggested next step
 * - objections: Objection rows from the last 7 days grouped by category
 * - results: last 7 days vs the previous 7 days (same definitions as /api/reports)
 *
 * Loaders are org-scoped Prisma reads only. Formatting is pure so it can be tested
 * without a database.
 */
import { BookingStatus, QualificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeObjectionCategory, type ObjectionCategory } from "@/services/messaging/objections";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Open leads with no activity for this many days are "stalled". */
export const LEAD_STALE_DAYS = 7;
/** Same threshold the dashboard uses for high-value leads. */
export const HOT_LEAD_SCORE = 70;

const WON_SLUGS = new Set(["won"]);
const LOST_SLUGS = new Set(["lost", "disqualified"]);

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function personName(contact: { fullName: string | null; instagramUsername: string | null } | null | undefined): string {
  if (!contact) return "Unknown contact";
  if (contact.fullName?.trim()) return contact.fullName.trim();
  if (contact.instagramUsername?.trim()) return `@${contact.instagramUsername.trim().replace(/^@/, "")}`;
  return "Unknown contact";
}

function ago(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Lead pipeline
// ---------------------------------------------------------------------------

export type PipelineStageRow = {
  id: string;
  name: string;
  slug: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  pipeline: { id: string; name: string; isDefault: boolean } | null;
};

export type LeadRow = {
  id: string;
  score: number | null;
  qualificationStatus: QualificationStatus | string;
  stageId: string | null;
  updatedAt: Date;
  contact: { fullName: string | null; instagramUsername: string | null } | null;
  conversation: {
    lastMessageAt: Date | null;
    needsHumanReview: boolean;
    handlingMode: string;
  } | null;
};

export type StageCount = {
  stageId: string | null;
  name: string;
  slug: string | null;
  count: number;
  closed: "won" | "lost" | null;
};

export type PipelineLead = {
  leadId: string;
  name: string;
  score: number;
  stage: string;
  daysQuiet: number;
  needsHuman: boolean;
  nextAction: string;
};

export type LeadPipelineSummary = {
  totalLeads: number;
  openLeads: number;
  wonLeads: number;
  lostLeads: number;
  stages: StageCount[];
  stalled: PipelineLead[];
  /** Leads at or above HOT_LEAD_SCORE; when none, the highest-scoring open leads. */
  hot: PipelineLead[];
  hotIsFallback: boolean;
  needsHuman: PipelineLead[];
  nextActions: string[];
};

function stageClosed(stage: { slug: string; isWon: boolean; isLost: boolean } | undefined): "won" | "lost" | null {
  if (!stage) return null;
  if (stage.isWon || WON_SLUGS.has(stage.slug)) return "won";
  if (stage.isLost || LOST_SLUGS.has(stage.slug)) return "lost";
  return null;
}

/** Plain next step for one lead, from its stage and state. */
export function nextActionForLead(input: {
  stageSlug: string | null;
  score: number;
  daysQuiet: number;
  needsHuman: boolean;
}): string {
  const slug = input.stageSlug ?? "";
  let action: string;
  switch (slug) {
    case "":
    case "new":
    case "contacted":
      action = "Reply and ask a qualifying question (what they want, date, budget)";
      break;
    case "engaged":
    case "qualifying":
      action = "Finish qualifying: confirm their date and budget";
      break;
    case "qualified":
      action = "Send the booking link and offer two specific slots";
      break;
    case "booking_offered":
      action = "Chase the booking: ask which slot works";
      break;
    case "booked":
      action = "Confirm the appointment and send any prep details";
      break;
    case "attended":
      action = "Ask for a review and offer a rebook";
      break;
    case "no_show":
      action = "Message to rebook the missed appointment";
      break;
    default:
      action =
        input.score >= HOT_LEAD_SCORE
          ? "Move them to booking: send the booking link"
          : "Follow up and move them to the next stage";
  }
  const lower = `${action.charAt(0).toLowerCase()}${action.slice(1)}`;
  if (input.needsHuman) return `Reply personally (flagged for a human) — ${lower}`;
  if (input.daysQuiet >= LEAD_STALE_DAYS) return `Re-engage (quiet ${input.daysQuiet} days): ${lower}`;
  return action;
}

export function buildLeadPipelineSummary(input: {
  stages: PipelineStageRow[];
  stageCounts: Array<{ stageId: string | null; count: number }>;
  leads: LeadRow[];
  now?: Date;
}): LeadPipelineSummary {
  const now = (input.now ?? new Date()).getTime();
  const stageById = new Map(input.stages.map((s) => [s.id, s]));
  const pipelineIdsWithLeads = new Set<string>();
  for (const row of input.stageCounts) {
    const pid = row.stageId ? stageById.get(row.stageId)?.pipeline?.id : undefined;
    if (pid && row.count > 0) pipelineIdsWithLeads.add(pid);
  }
  const multiPipeline = pipelineIdsWithLeads.size > 1;

  const countByStage = new Map<string | null, number>();
  for (const row of input.stageCounts) {
    const key = row.stageId && stageById.has(row.stageId) ? row.stageId : null;
    countByStage.set(key, (countByStage.get(key) ?? 0) + row.count);
  }

  // Default pipeline first, then any pipeline holding leads; stage position order.
  const visibleStages = input.stages
    .filter((s) => !s.pipeline || s.pipeline.isDefault || pipelineIdsWithLeads.has(s.pipeline.id) || (countByStage.get(s.id) ?? 0) > 0)
    .sort((a, b) => {
      const ad = a.pipeline?.isDefault ? 0 : 1;
      const bd = b.pipeline?.isDefault ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const ap = a.pipeline?.name ?? "";
      const bp = b.pipeline?.name ?? "";
      if (ap !== bp) return ap.localeCompare(bp);
      return a.position - b.position;
    });

  const stages: StageCount[] = visibleStages.map((s) => ({
    stageId: s.id,
    name: multiPipeline && s.pipeline ? `${s.pipeline.name} › ${s.name}` : s.name,
    slug: s.slug,
    count: countByStage.get(s.id) ?? 0,
    closed: stageClosed(s),
  }));
  const unstaged = countByStage.get(null) ?? 0;
  if (unstaged > 0) {
    stages.push({ stageId: null, name: "No stage yet", slug: null, count: unstaged, closed: null });
  }

  const totalLeads = stages.reduce((sum, s) => sum + s.count, 0);
  const wonLeads = stages.filter((s) => s.closed === "won").reduce((sum, s) => sum + s.count, 0);
  const lostLeads = stages.filter((s) => s.closed === "lost").reduce((sum, s) => sum + s.count, 0);

  const open: PipelineLead[] = [];
  for (const lead of input.leads) {
    const stage = lead.stageId ? stageById.get(lead.stageId) : undefined;
    if (stageClosed(stage)) continue;
    if (lead.qualificationStatus === QualificationStatus.DISQUALIFIED) continue;
    const lastActivity = Math.max(
      lead.updatedAt.getTime(),
      lead.conversation?.lastMessageAt?.getTime() ?? 0,
    );
    const daysQuiet = Math.max(0, Math.floor((now - lastActivity) / DAY_MS));
    const needsHuman = Boolean(
      lead.conversation?.needsHumanReview || lead.conversation?.handlingMode === "HUMAN",
    );
    const score = lead.score ?? 0;
    open.push({
      leadId: lead.id,
      name: personName(lead.contact),
      score,
      stage: stage?.name ?? "No stage yet",
      daysQuiet,
      needsHuman,
      nextAction: nextActionForLead({ stageSlug: stage?.slug ?? null, score, daysQuiet, needsHuman }),
    });
  }

  const stalled = open
    .filter((l) => l.daysQuiet >= LEAD_STALE_DAYS)
    .sort((a, b) => b.score - a.score || b.daysQuiet - a.daysQuiet)
    .slice(0, 5);
  let hot = open
    .filter((l) => l.score >= HOT_LEAD_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  let hotIsFallback = false;
  if (!hot.length) {
    hot = open
      .filter((l) => l.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    hotIsFallback = hot.length > 0;
  }
  const needsHuman = open.filter((l) => l.needsHuman).slice(0, 5);

  const nextActions: string[] = [];
  const seen = new Set<string>();
  const pushLead = (l: PipelineLead) => {
    if (seen.has(l.leadId) || nextActions.length >= 5) return;
    seen.add(l.leadId);
    nextActions.push(`${l.name} (${l.stage}${l.score ? `, score ${l.score}` : ""}): ${l.nextAction}`);
  };
  needsHuman.forEach(pushLead);
  if (!hotIsFallback) hot.forEach(pushLead);
  stalled.forEach(pushLead);
  if (nextActions.length < 5) {
    const earliest = stages.find(
      (s) => !s.closed && s.count > 0 && (s.slug === "new" || s.slug === "contacted" || s.slug === null),
    );
    if (earliest) {
      nextActions.push(
        `${plural(earliest.count, "lead")} waiting in “${earliest.name}” — reply and qualify them so they move forward`,
      );
    }
  }

  return {
    totalLeads,
    openLeads: Math.max(0, totalLeads - wonLeads - lostLeads),
    wonLeads,
    lostLeads,
    stages,
    stalled,
    hot,
    hotIsFallback,
    needsHuman,
    nextActions,
  };
}

export function formatLeadPipelineLines(summary: LeadPipelineSummary): string[] {
  if (summary.totalLeads === 0) {
    return [
      "LEAD PIPELINE",
      "• No leads in this workspace yet — new Instagram DMs become leads automatically once conversations start.",
    ];
  }
  const closedBits = [
    summary.wonLeads ? `${summary.wonLeads} won` : null,
    summary.lostLeads ? `${summary.lostLeads} lost/disqualified` : null,
  ].filter(Boolean);
  const lines: string[] = [
    `LEAD PIPELINE — ${plural(summary.openLeads, "open lead")}${closedBits.length ? ` (${closedBits.join(", ")})` : ""}`,
    `• By stage: ${summary.stages.map((s) => `${s.name} ${s.count}`).join(" · ")}`,
  ];

  lines.push("", `STUCK / STALLED LEADS (no activity ${LEAD_STALE_DAYS}+ days): ${summary.stalled.length}`);
  if (summary.stalled.length) {
    for (const l of summary.stalled) {
      lines.push(`• ${l.name} — ${l.stage}, quiet ${l.daysQuiet} days → ${l.nextAction}`);
    }
  } else {
    lines.push("• None — every open lead has had activity in the last week.");
  }

  lines.push(
    "",
    summary.hotIsFallback
      ? `HOT LEADS — none scored ${HOT_LEAD_SCORE}+ yet; highest-scoring open leads:`
      : `HOT LEADS (score ${HOT_LEAD_SCORE}+): ${summary.hot.length}`,
  );
  if (summary.hot.length) {
    for (const l of summary.hot) {
      lines.push(`• ${l.name} — score ${l.score}, ${l.stage} → ${l.nextAction}`);
    }
  } else {
    lines.push("• No scored leads yet.");
  }

  if (summary.nextActions.length) {
    lines.push("", "NEXT ACTIONS");
    summary.nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  return lines;
}

/** Org-scoped read of the lead pipeline (soft-deleted leads/contacts excluded). */
export async function loadLeadPipelineSummary(
  organisationId: string,
  now: Date = new Date(),
): Promise<LeadPipelineSummary> {
  const liveLead = { organisationId, deletedAt: null, contact: { deletedAt: null } };
  const [stages, grouped, leads] = await Promise.all([
    prisma.pipelineStage.findMany({
      where: { pipeline: { organisationId } },
      orderBy: { position: "asc" },
      take: 100,
      select: {
        id: true,
        name: true,
        slug: true,
        position: true,
        isWon: true,
        isLost: true,
        pipeline: { select: { id: true, name: true, isDefault: true } },
      },
    }),
    prisma.lead.groupBy({
      by: ["stageId"],
      where: liveLead,
      _count: { _all: true },
    }),
    prisma.lead.findMany({
      where: liveLead,
      orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
      take: 300,
      select: {
        id: true,
        score: true,
        qualificationStatus: true,
        stageId: true,
        updatedAt: true,
        contact: { select: { fullName: true, instagramUsername: true } },
        conversation: {
          select: { lastMessageAt: true, needsHumanReview: true, handlingMode: true },
        },
      },
    }),
  ]);
  return buildLeadPipelineSummary({
    stages: stages as PipelineStageRow[],
    stageCounts: (grouped as Array<{ stageId: string | null; _count: { _all: number } }>).map((g) => ({
      stageId: g.stageId,
      count: g._count._all,
    })),
    leads: leads as LeadRow[],
    now,
  });
}

// ---------------------------------------------------------------------------
// DM triage — conversations that need a reply or a human
// ---------------------------------------------------------------------------

export type DmConversationRow = {
  id: string;
  needsHumanReview: boolean;
  handlingMode: string;
  unreadCount: number | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastMessagePreview: string | null;
  handoffReason: string | null;
  intent: string | null;
  priorityClass: string | null;
  messagingWindowExpiresAt: Date | null;
  contact: { fullName: string | null; instagramUsername: string | null } | null;
  leads: Array<{
    score: number | null;
    qualificationStatus: QualificationStatus | string;
    stage: { name: string; slug: string } | null;
  }>;
};

export type DmTriageItem = {
  conversationId: string;
  name: string;
  reason: "needs_human" | "awaiting_reply";
  waiting: string | null;
  lastMessage: string | null;
  leadStage: string | null;
  leadScore: number | null;
  nextStep: string;
};

export type DmTriage = {
  needsHuman: number;
  awaitingReply: number;
  items: DmTriageItem[];
};

function dmNeedsHuman(c: DmConversationRow): boolean {
  return Boolean(c.needsHumanReview || c.handlingMode === "HUMAN");
}

function dmAwaitingReply(c: DmConversationRow): boolean {
  if ((c.unreadCount ?? 0) > 0) return true;
  if (!c.lastInboundAt) return false;
  return !c.lastOutboundAt || c.lastInboundAt.getTime() > c.lastOutboundAt.getTime();
}

/** One concrete next step for a DM thread — rule-based, never sends anything. */
export function suggestDmNextStep(c: DmConversationRow, now: Date = new Date()): string {
  const preview = (c.lastMessagePreview || "").toLowerCase();
  const intent = (c.intent || "").toLowerCase();
  const lead = c.leads[0];
  const slug = lead?.stage?.slug ?? "";
  const score = lead?.score ?? 0;
  let step: string;
  if (/pric|cost|how much|£|\$|expensive|deposit/.test(preview) || intent.includes("pric")) {
    step = "answer the price question with your package range, then offer a consultation or booking slot";
  } else if (
    /\b(book|booking|availab|appointment|slot|free on|when can)/.test(preview) ||
    intent.includes("booking")
  ) {
    step = slug === "booked" ? "confirm their appointment details" : "send your booking link and suggest two specific times";
  } else if (score >= HOT_LEAD_SCORE || slug === "qualified" || slug === "booking_offered") {
    step = "hot lead — send the booking link and ask which date suits them";
  } else if (slug === "booked") {
    step = "confirm the appointment and answer anything they've asked";
  } else if (!lead || slug === "new" || slug === "contacted" || slug === "") {
    step = "reply and ask a qualifying question (what they want, date, budget)";
  } else {
    step = "reply to their last message and move them to the next step";
  }
  if (dmNeedsHuman(c)) {
    const why = c.handoffReason?.trim() ? ` (handed over: ${clip(c.handoffReason, 80)})` : "";
    step = `Reply personally${why} — ${step}`;
  } else {
    step = step.charAt(0).toUpperCase() + step.slice(1);
  }
  if (c.messagingWindowExpiresAt) {
    const left = c.messagingWindowExpiresAt.getTime() - now.getTime();
    if (left > 0 && left <= DAY_MS) {
      step += ` — ${Math.max(1, Math.floor(left / HOUR_MS))}h left in the 24-hour messaging window`;
    } else if (left <= 0) {
      step += " — the 24-hour messaging window has passed; check Inbox before replying";
    }
  }
  return step;
}

export function buildDmTriage(rows: DmConversationRow[], now: Date = new Date()): DmTriage {
  const relevant = rows.filter((c) => dmNeedsHuman(c) || dmAwaitingReply(c));
  const needsHuman = relevant.filter(dmNeedsHuman).length;
  const awaitingReply = relevant.length - needsHuman;
  const sorted = [...relevant].sort((a, b) => {
    const ah = dmNeedsHuman(a) ? 0 : 1;
    const bh = dmNeedsHuman(b) ? 0 : 1;
    if (ah !== bh) return ah - bh;
    const as = a.leads[0]?.score ?? 0;
    const bs = b.leads[0]?.score ?? 0;
    const aHot = as >= HOT_LEAD_SCORE || a.priorityClass === "HOT_LEAD" ? 0 : 1;
    const bHot = bs >= HOT_LEAD_SCORE || b.priorityClass === "HOT_LEAD" ? 0 : 1;
    if (aHot !== bHot) return aHot - bHot;
    // Longest-waiting first.
    const aw = (a.lastInboundAt ?? a.lastMessageAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bw = (b.lastInboundAt ?? b.lastMessageAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aw - bw;
  });
  const items = sorted.slice(0, 8).map((c) => {
    const since = c.lastInboundAt ?? c.lastMessageAt;
    const lead = c.leads[0];
    return {
      conversationId: c.id,
      name: personName(c.contact),
      reason: dmNeedsHuman(c) ? ("needs_human" as const) : ("awaiting_reply" as const),
      waiting: since ? ago(Math.max(0, now.getTime() - since.getTime())) : null,
      lastMessage: c.lastMessagePreview?.trim() ? clip(c.lastMessagePreview, 110) : null,
      leadStage: lead?.stage?.name ?? null,
      leadScore: lead?.score ?? null,
      nextStep: suggestDmNextStep(c, now),
    };
  });
  return { needsHuman, awaitingReply, items };
}

export function formatDmTriageLines(triage: DmTriage): string[] {
  const total = triage.needsHuman + triage.awaitingReply;
  if (total === 0) {
    return [
      "DMs TO HANDLE — none right now",
      "• No open Instagram conversations are waiting on you: nothing is flagged for a human and every customer message has a reply.",
    ];
  }
  const lines = [
    `DMs TO HANDLE — ${plural(total, "conversation")} (${triage.needsHuman} flagged for a human, ${triage.awaitingReply} waiting for a reply)`,
  ];
  triage.items.forEach((item, i) => {
    const meta = [
      item.reason === "needs_human" ? "needs a human" : "waiting for a reply",
      item.waiting ? `last message ${item.waiting} ago` : null,
      item.leadStage ? `lead: ${item.leadStage}${item.leadScore ? `, score ${item.leadScore}` : ""}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${i + 1}. ${item.name} — ${meta}`);
    if (item.lastMessage) lines.push(`   Last message: “${item.lastMessage}”`);
    lines.push(`   → Next step: ${item.nextStep}`);
  });
  if (total > triage.items.length) {
    lines.push(`…and ${total - triage.items.length} more in Inbox.`);
  }
  lines.push("", "Nothing has been sent — open Inbox to reply or approve drafts.");
  return lines;
}

/** Recent open conversations (newest activity first) for DM triage. */
export async function loadDmTriage(organisationId: string, now: Date = new Date()): Promise<DmTriage> {
  const rows = await prisma.conversation.findMany({
    where: { organisationId, deletedAt: null, closedAt: null, contact: { deletedAt: null } },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    take: 80,
    select: {
      id: true,
      needsHumanReview: true,
      handlingMode: true,
      unreadCount: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      lastMessagePreview: true,
      handoffReason: true,
      intent: true,
      priorityClass: true,
      messagingWindowExpiresAt: true,
      contact: { select: { fullName: true, instagramUsername: true } },
      leads: {
        where: { deletedAt: null },
        orderBy: { score: "desc" },
        take: 1,
        select: {
          score: true,
          qualificationStatus: true,
          stage: { select: { name: true, slug: true } },
        },
      },
    },
  });
  return buildDmTriage(rows as DmConversationRow[], now);
}

// ---------------------------------------------------------------------------
// Objections
// ---------------------------------------------------------------------------

export const OBJECTION_WINDOW_DAYS = 7;

const OBJECTION_LABEL: Record<ObjectionCategory, string> = {
  PRICE: "Price",
  TRUST: "Trust",
  TIMING: "Timing",
  AUTHORITY: "Decision-maker",
  NEED: "Need / fit",
  IMPLEMENTATION: "Process / how it works",
  COMPETITOR: "Competitor",
  FEATURE: "What's included",
  RISK: "Risk / reassurance",
  OTHER: "Other",
};

/** Suggested response playbook per controlled objection category. */
export const OBJECTION_RESPONSE: Record<ObjectionCategory, string> = {
  PRICE:
    "Lead with what's included and the result, give your price range up front, and offer a deposit or smaller starter option.",
  TRUST:
    "Share reviews, before/after photos or credentials, and invite them to a no-pressure consultation.",
  TIMING:
    "Acknowledge the timing, offer to hold a date or send a reminder closer to the time, and mention how far ahead you book up.",
  AUTHORITY:
    "Give them something easy to share (price list, portfolio) and offer a joint chat with whoever is deciding.",
  NEED:
    "Ask what result they want, then point them to the one package that fits — keep it simple.",
  IMPLEMENTATION:
    "Walk them through the steps (consultation/trial, the day itself, aftercare) so the process feels easy.",
  COMPETITOR:
    "Don't knock the other option — highlight what's different about you (experience, inclusions, reviews).",
  FEATURE:
    "Confirm exactly what's included and offer the closest option or an add-on that covers the gap.",
  RISK:
    "Reassure with your policies (patch tests, guarantees, cancellation/reschedule terms).",
  OTHER: "Reply personally, then turn the question into an FAQ or saved reply.",
};

export type ObjectionRow = {
  category: string;
  text: string;
  detectedAt: Date;
  conversation: { contact: { fullName: string | null; instagramUsername: string | null } | null } | null;
};

export type ObjectionCategorySummary = {
  category: ObjectionCategory;
  label: string;
  count: number;
  share: number;
  examples: string[];
  suggestedResponse: string;
};

export type ObjectionSummary = {
  windowDays: number;
  total: number;
  categories: ObjectionCategorySummary[];
  /** Older (8–30 day) categories, only populated when the 7-day window is empty. */
  earlier: Array<{ label: string; count: number }>;
  earlierLatestAt: Date | null;
};

export function buildObjectionSummary(rows: ObjectionRow[], now: Date = new Date()): ObjectionSummary {
  const since = now.getTime() - OBJECTION_WINDOW_DAYS * DAY_MS;
  const recent = rows.filter((r) => r.detectedAt.getTime() >= since);
  const groups = new Map<ObjectionCategory, ObjectionRow[]>();
  for (const row of recent) {
    const cat = normalizeObjectionCategory(row.category);
    const list = groups.get(cat) ?? [];
    list.push(row);
    groups.set(cat, list);
  }
  const categories = [...groups.entries()]
    .map(([category, list]) => {
      const examples: string[] = [];
      const seen = new Set<string>();
      for (const r of [...list].sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())) {
        const text = r.text?.trim();
        if (!text || text.toUpperCase() === category) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const who = r.conversation?.contact ? personName(r.conversation.contact) : null;
        examples.push(`“${clip(text, 110)}”${who && who !== "Unknown contact" ? ` — ${who}` : ""}`);
        if (examples.length >= 2) break;
      }
      return {
        category,
        label: OBJECTION_LABEL[category],
        count: list.length,
        share: recent.length ? list.length / recent.length : 0,
        examples,
        suggestedResponse: OBJECTION_RESPONSE[category],
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  let earlier: ObjectionSummary["earlier"] = [];
  let earlierLatestAt: Date | null = null;
  if (!recent.length && rows.length) {
    const counts = new Map<ObjectionCategory, number>();
    for (const r of rows) {
      const cat = normalizeObjectionCategory(r.category);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
      if (!earlierLatestAt || r.detectedAt > earlierLatestAt) earlierLatestAt = r.detectedAt;
    }
    earlier = [...counts.entries()]
      .map(([cat, count]) => ({ label: OBJECTION_LABEL[cat], count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
  }

  return { windowDays: OBJECTION_WINDOW_DAYS, total: recent.length, categories, earlier, earlierLatestAt };
}

export function formatObjectionLines(summary: ObjectionSummary): string[] {
  if (summary.total === 0) {
    const lines = [
      `OBJECTIONS — last ${summary.windowDays} days: none recorded`,
      `• No objections were detected in your conversations in the last ${summary.windowDays} days.`,
    ];
    if (summary.earlier.length) {
      lines.push(
        `• Earlier this month: ${summary.earlier.map((e) => `${e.label} (${e.count})`).join(", ")}${
          summary.earlierLatestAt ? ` — most recent ${summary.earlierLatestAt.toISOString().slice(0, 10)}` : ""
        }.`,
      );
    }
    lines.push(
      "• Objections are logged automatically when a customer pushes back in a DM (price, timing, trust…). Ask again once more conversations come in.",
    );
    return lines;
  }
  const lines = [
    `OBJECTIONS — last ${summary.windowDays} days: ${summary.total} across ${plural(summary.categories.length, "category", "categories")}`,
  ];
  summary.categories.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.label} — ${c.count} (${Math.round(c.share * 100)}%)`);
    if (c.examples.length) lines.push(`   Examples: ${c.examples.join(" · ")}`);
    lines.push(`   → Suggested response: ${c.suggestedResponse}`);
  });
  const top = summary.categories[0];
  if (top) {
    lines.push(
      "",
      `Tip: ${top.label.toLowerCase()} is your most common objection — save the suggested response as a quick reply and cover it in a post or highlight.`,
    );
  }
  return lines;
}

/** Objections from the last 30 days (soft-deleted conversations excluded, as in Reports). */
export async function loadObjectionSummary(
  organisationId: string,
  now: Date = new Date(),
): Promise<ObjectionSummary> {
  const rows = await prisma.objection.findMany({
    where: {
      organisationId,
      detectedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
      OR: [{ conversationId: null }, { conversation: { deletedAt: null, contact: { deletedAt: null } } }],
    },
    orderBy: { detectedAt: "desc" },
    take: 500,
    select: {
      category: true,
      text: true,
      detectedAt: true,
      conversation: { select: { contact: { select: { fullName: true, instagramUsername: true } } } },
    },
  });
  return buildObjectionSummary(rows as ObjectionRow[], now);
}

// ---------------------------------------------------------------------------
// Results — last 7 days vs previous 7 days
// ---------------------------------------------------------------------------

export type ResultsWindow = {
  conversations: number;
  newLeads: number;
  qualified: number;
  bookings: number;
  messagesReceived: number;
  repliesSent: number;
  followUpsSent: number;
};

export type ResultsReport = {
  periodStart: Date;
  periodEnd: Date;
  current: ResultsWindow;
  previous: ResultsWindow;
  conversion: number;
  previousConversion: number;
  topObjections: Array<{ label: string; count: number }>;
  stalledLeads: Array<{ name: string; stage: string; daysQuiet: number }>;
  openLeads: number;
};

function delta(cur: number, prev: number): string {
  const d = cur - prev;
  if (d === 0) return "no change";
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Up to three concrete next steps drawn from the weekly numbers. */
export function resultsNextSteps(report: ResultsReport): string[] {
  const { current: c, previous: p } = report;
  const next: string[] = [];
  if (report.stalledLeads[0]) next.push(`Re-engage ${report.stalledLeads[0].name} and the other quiet leads.`);
  if (c.qualified > c.bookings) next.push("Send booking links to qualified leads who haven't booked yet.");
  if (report.topObjections[0]) {
    next.push(`Prepare a saved reply for ${report.topObjections[0].label.toLowerCase()} objections.`);
  }
  if (c.conversations < p.conversations) next.push("Inbound is down — post or run a story to drive new DMs.");
  return next.slice(0, 3);
}

export function formatResultsLines(report: ResultsReport): string[] {
  const { current: c, previous: p } = report;
  const lines = [
    `RESULTS — last 7 days (${shortDate(report.periodStart)} – ${shortDate(report.periodEnd)}) vs the 7 days before`,
    `• New conversations: ${c.conversations} (previous ${p.conversations}, ${delta(c.conversations, p.conversations)})`,
    `• New leads: ${c.newLeads} (previous ${p.newLeads}, ${delta(c.newLeads, p.newLeads)})`,
    `• Qualified leads: ${c.qualified} (previous ${p.qualified}, ${delta(c.qualified, p.qualified)})`,
    `• Bookings / meetings: ${c.bookings} (previous ${p.bookings}, ${delta(c.bookings, p.bookings)})`,
    `• Replies sent: ${c.repliesSent} (previous ${p.repliesSent}, ${delta(c.repliesSent, p.repliesSent)}) · messages received: ${c.messagesReceived} (previous ${p.messagesReceived})`,
    `• Conversion (bookings ÷ new conversations): ${pct(report.conversion)} (previous ${pct(report.previousConversion)})`,
    `• Follow-ups sent: ${c.followUpsSent} (previous ${p.followUpsSent})`,
  ];

  const metrics: Array<[string, number, number]> = [
    ["new conversations", c.conversations, p.conversations],
    ["new leads", c.newLeads, p.newLeads],
    ["qualified leads", c.qualified, p.qualified],
    ["bookings", c.bookings, p.bookings],
    ["replies sent", c.repliesSent, p.repliesSent],
  ];
  const up = metrics.filter(([, cur, prev]) => cur > prev).sort((a, b) => b[1] - b[2] - (a[1] - a[2]));
  const down = metrics.filter(([, cur, prev]) => cur < prev).sort((a, b) => a[1] - a[2] - (b[1] - b[2]));

  lines.push("", "WHAT MOVED");
  if (up.length) {
    for (const [name, cur, prev] of up.slice(0, 3)) lines.push(`• ${name} up ${cur - prev} (${prev} → ${cur})`);
  } else {
    lines.push("• Nothing grew versus the previous week.");
  }
  if (down.length) {
    for (const [name, cur, prev] of down.slice(0, 3)) lines.push(`• ${name} down ${prev - cur} (${prev} → ${cur})`);
  }

  lines.push("", "WHAT STALLED");
  if (report.stalledLeads.length) {
    lines.push(
      `• ${plural(report.stalledLeads.length, "open lead")} quiet ${LEAD_STALE_DAYS}+ days: ${report.stalledLeads
        .map((l) => `${l.name} (${l.stage}, ${l.daysQuiet}d)`)
        .join("; ")}`,
    );
  } else {
    lines.push(`• No open leads have gone quiet for ${LEAD_STALE_DAYS}+ days.`);
  }
  if (c.conversations > 0 && c.bookings === 0) {
    lines.push("• Conversations came in but none turned into a booking this week.");
  }
  if (report.topObjections.length) {
    lines.push(
      `• Top objections this week: ${report.topObjections.map((o) => `${o.label} (${o.count})`).join(", ")}`,
    );
  }

  const next = resultsNextSteps(report);
  if (next.length) {
    lines.push("", "NEXT");
    next.forEach((n) => lines.push(`• ${n}`));
  }
  lines.push(
    "",
    "Source: this workspace's Inbox, Leads and Bookings (same counting as the Reports page). No web research.",
  );
  return lines;
}

async function loadResultsWindow(organisationId: string, gte: Date, lt: Date): Promise<ResultsWindow> {
  const createdAt = { gte, lt };
  const liveContact = { contact: { deletedAt: null } };
  const [conversations, newLeads, qualified, bookings, messagesReceived, repliesSent, followUpsSent] =
    await Promise.all([
      prisma.conversation.count({ where: { organisationId, deletedAt: null, ...liveContact, createdAt } }),
      prisma.lead.count({ where: { organisationId, deletedAt: null, ...liveContact, createdAt } }),
      prisma.lead.count({
        where: {
          organisationId,
          deletedAt: null,
          qualificationStatus: QualificationStatus.QUALIFIED,
          ...liveContact,
          createdAt,
        },
      }),
      prisma.booking.count({
        where: {
          organisationId,
          status: { in: [BookingStatus.CREATED, BookingStatus.ATTENDED] },
          ...liveContact,
          createdAt,
        },
      }),
      prisma.message.count({
        where: { organisationId, direction: "INBOUND", sentAt: createdAt, conversation: { deletedAt: null } },
      }),
      prisma.message.count({
        where: {
          organisationId,
          direction: "OUTBOUND",
          senderType: { in: ["AI", "HUMAN"] },
          sentAt: createdAt,
          conversation: { deletedAt: null },
        },
      }),
      prisma.followUp.count({ where: { organisationId, status: "SENT", ...liveContact, createdAt } }),
    ]);
  return { conversations, newLeads, qualified, bookings, messagesReceived, repliesSent, followUpsSent };
}

/**
 * Weekly results for the Ask "Show me results" / "Weekly performance" cards.
 * Definitions mirror POST /api/reports: soft-deleted contacts excluded, bookings =
 * CREATED|ATTENDED, qualified = leads created in the window with QUALIFIED status,
 * conversion = bookings ÷ new conversations.
 */
export async function loadResultsReport(organisationId: string, now: Date = new Date()): Promise<ResultsReport> {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 7 * DAY_MS);
  const previousStart = new Date(now.getTime() - 14 * DAY_MS);
  const [current, previous, objections, pipeline] = await Promise.all([
    loadResultsWindow(organisationId, periodStart, new Date(periodEnd.getTime() + 1)),
    loadResultsWindow(organisationId, previousStart, periodStart),
    loadObjectionSummary(organisationId, now).catch(() => null),
    loadLeadPipelineSummary(organisationId, now).catch(() => null),
  ]);
  return {
    periodStart,
    periodEnd,
    current,
    previous,
    conversion: current.conversations > 0 ? current.bookings / current.conversations : 0,
    previousConversion: previous.conversations > 0 ? previous.bookings / previous.conversations : 0,
    topObjections: (objections?.categories ?? []).slice(0, 3).map((c) => ({ label: c.label, count: c.count })),
    stalledLeads: (pipeline?.stalled ?? []).map((l) => ({ name: l.name, stage: l.stage, daysQuiet: l.daysQuiet })),
    openLeads: pipeline?.openLeads ?? 0,
  };
}
