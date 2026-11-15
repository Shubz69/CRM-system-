/**
 * Phase 8 Automation OS — NL → visible workflow compile + approval gates.
 * Deterministic compile (no invented capabilities). Outbound stays approval-gated.
 */

import { ApprovalRequestStatus, FollowUpStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ensureBuiltinToolsRegistered, evaluateToolPolicy } from "@/kernel";
import {
  AUTOMATION_TRIGGERS,
  EXECUTABLE_AUTOMATION_ACTIONS,
  isExecutableAutomationAction,
  isFiringAutomationTrigger,
  type AutomationTrigger,
} from "@/lib/customer-labels";

export type WorkflowStep = {
  id: string;
  kind: "trigger" | "condition" | "logic" | "action" | "approval" | "outcome";
  label: string;
  detail?: string;
  actionType?: string;
  gated?: boolean;
};

export type VisibleWorkflow = {
  version: 1;
  triggerType: string;
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  steps: WorkflowStep[];
  requiresApproval: boolean;
  compiledFrom?: string;
  unsupportedNotes?: string[];
};

const OUTBOUND_ACTIONS = new Set([
  "send_follow_up",
  "schedule_follow_up",
  "send_booking_link",
  "send_message",
  "publish_content",
]);

export function isOutboundAction(type: string): boolean {
  return OUTBOUND_ACTIONS.has(type);
}

/**
 * Validate a rule's trigger and actions against what actually runs:
 * the trigger must be one that is emitted, and every action must have an executor.
 * Returns a customer-readable error, or null when valid. Omitted fields are not checked.
 */
/** Triggers that run after the AI has scored the message (payload carries score + sentiment). */
const SCORED_TRIGGERS = new Set([
  "human_requested",
  "negative_sentiment",
  "lead_score_changed",
  "lead_qualified",
  "lead_disqualified",
]);
/** Triggers whose payload carries the customer's message text. */
const TEXT_TRIGGERS = new Set([...SCORED_TRIGGERS, "new_inbound_message", "lead_replied"]);

/**
 * Conditions fail closed (a condition the event can't answer never matches), so reject
 * conditions the chosen trigger can never satisfy instead of saving a rule that never runs.
 */
function conditionProblem(triggerType: string, conditions: Record<string, unknown>): string | null {
  if ((conditions.minScore !== undefined || conditions.sentiment !== undefined) && !SCORED_TRIGGERS.has(triggerType)) {
    return `Score and sentiment conditions only work with triggers that run after the AI has assessed the message: ${[...SCORED_TRIGGERS].join(", ")}.`;
  }
  if (conditions.topicIncludes !== undefined && !TEXT_TRIGGERS.has(triggerType)) {
    return `Topic conditions need the customer's message — use one of: ${[...TEXT_TRIGGERS].join(", ")}.`;
  }
  if (conditions.minutes !== undefined) {
    return "Inactivity minutes can't be checked by any trigger — schedule a follow-up action with a delay instead.";
  }
  return null;
}

export function validateAutomationRule(input: {
  triggerType?: string | null;
  actions?: Array<Record<string, unknown>> | null;
  conditions?: Record<string, unknown> | null;
}): string | null {
  if (input.triggerType !== undefined && input.triggerType !== null) {
    if (!isFiringAutomationTrigger(input.triggerType)) {
      return `Unknown trigger "${input.triggerType}" — it never fires. Use one of: ${AUTOMATION_TRIGGERS.join(", ")}.`;
    }
    if (input.conditions) {
      const problem = conditionProblem(input.triggerType, input.conditions);
      if (problem) return problem;
    }
  }
  if (input.actions) {
    if (input.actions.length === 0) return "Add at least one action.";
    for (const action of input.actions) {
      const type = typeof action?.type === "string" ? action.type : "";
      if (!isExecutableAutomationAction(type)) {
        return `Action "${type || "(missing)"}" is not supported by automations. Use one of: ${EXECUTABLE_AUTOMATION_ACTIONS.join(", ")}.`;
      }
    }
  }
  return null;
}

/**
 * Compile natural language into a visible workflow. Only triggers that fire and actions
 * with an executor are emitted.
 */
export function compileNaturalLanguageToWorkflow(nl: string): VisibleWorkflow {
  const text = nl.trim();
  if (!text) throw new Error("Natural language is required");

  const lower = text.toLowerCase();
  const unsupported: string[] = [];
  const mentionsInactivity =
    lower.includes("inactive") ||
    lower.includes("no reply") ||
    lower.includes("no response") ||
    /\b(?:doesn't|does not|hasn't|has not|don't|didn't) (?:reply|respond)/.test(lower);
  let triggerType: AutomationTrigger = "lead_created";
  // "disqualified" contains "qualified" — check it first.
  if (lower.includes("disqualified")) {
    triggerType = "lead_disqualified";
  } else if (lower.includes("qualified") || lower.includes("qualification")) {
    triggerType = "lead_qualified";
  } else if (mentionsInactivity) {
    // There is no inactivity trigger. Scheduling the follow-up on each inbound message gives the
    // same effect: pending follow-ups are cancelled automatically when the lead replies.
    triggerType = "new_inbound_message";
    unsupported.push(
      "There is no inactivity trigger — this runs when a customer message arrives and schedules the follow-up after the delay. Pending follow-ups are cancelled automatically when the lead replies.",
    );
  } else if (
    (lower.includes("booking") && !lower.includes("booking link")) ||
    lower.includes("booked")
  ) {
    triggerType = "booking_created";
  } else if (
    lower.includes("message") ||
    lower.includes("inbound") ||
    lower.includes("asks about") ||
    lower.includes("dm")
  ) {
    triggerType = "new_inbound_message";
  }

  const conditions: Record<string, unknown> = {};
  const scoreMatch = lower.match(/scores?\s*(?:>=|>|above)\s*(\d+)/);
  if (scoreMatch) {
    conditions.minScore = Number(scoreMatch[1]);
    // A score only exists once the AI has assessed the message.
    if (!SCORED_TRIGGERS.has(triggerType)) triggerType = "lead_score_changed";
  }
  if (/\bpricing\b|\bprice\b/.test(lower)) {
    conditions.topicIncludes = ["pricing", "price"];
    // Topics are matched against the customer's message text.
    if (!TEXT_TRIGGERS.has(triggerType)) triggerType = "new_inbound_message";
  }
  const minutesMatch = lower.match(/(\d+)\s*min/);

  const actions: Array<Record<string, unknown>> = [];
  if (lower.includes("pause ai") || lower.includes("handover") || lower.includes("hand over")) {
    actions.push({ type: "handover" });
  }
  if (lower.includes("notify") || lower.includes("alert")) {
    actions.push({ type: "notify_team", message: "Automation alert from NL rule" });
  }
  if (
    lower.includes("draft") &&
    (lower.includes("reply") || lower.includes("response") || lower.includes("suggested"))
  ) {
    // Automations cannot draft replies — create a task for the team instead (never sends).
    actions.push({ type: "create_task", message: "Draft a reply for this lead and review it before sending." });
    unsupported.push(
      "Automations can't draft replies yet — a task is created for your team to draft one. Nothing is sent automatically.",
    );
  }
  if (lower.includes("never send") || lower.includes("for my review") || lower.includes("for review")) {
    conditions.requireHumanReview = true;
  }
  if (lower.includes("follow-up") || lower.includes("follow up") || lower.includes("nudge")) {
    actions.push({
      type: "send_follow_up",
      minutes: Number(minutesMatch?.[1] ?? 60),
    });
  }
  if (lower.includes("booking link") || lower.includes("send booking")) {
    actions.push({ type: "send_booking_link" });
  }
  if (lower.includes("tag ")) {
    const tagMatch = text.match(/tag\s+["']?([a-zA-Z0-9_-]+)["']?/i);
    if (tagMatch) actions.push({ type: "add_tag", tag: tagMatch[1] });
  }
  if (lower.includes("mark qualified") || lower.includes("as qualified")) {
    actions.push({ type: "mark_qualified" });
  }
  if (actions.length === 0) {
    actions.push({ type: "notify_team", message: "Rule matched (no specific action parsed)" });
    unsupported.push(
      "No specific supported action was recognised — saved as team notify only. Messages are never sent automatically.",
    );
  }

  const requiresApproval =
    actions.some((a) => isOutboundAction(String(a.type))) ||
    Boolean(conditions.requireHumanReview);
  const steps = buildWorkflowSteps({
    triggerType,
    conditions,
    actions,
    requiresApproval,
  });
  if (unsupported.length) {
    steps.push({
      id: "capability_note",
      kind: "outcome",
      label: "What this rule can do",
      detail: unsupported.join(" "),
    });
  }

  return {
    version: 1,
    triggerType,
    conditions,
    actions,
    steps,
    requiresApproval,
    compiledFrom: text.slice(0, 2000),
    unsupportedNotes: unsupported,
  };
}

export function buildWorkflowSteps(input: {
  triggerType: string;
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  requiresApproval: boolean;
}): WorkflowStep[] {
  const steps: WorkflowStep[] = [
    {
      id: "trigger",
      kind: "trigger",
      label: `When ${input.triggerType.replace(/_/g, " ")}`,
      detail: input.triggerType,
    },
  ];

  const condKeys = Object.keys(input.conditions);
  if (condKeys.length) {
    steps.push({
      id: "conditions",
      kind: "condition",
      label: "If conditions match",
      detail: condKeys.map((k) => `${k}=${String(input.conditions[k])}`).join(", "),
    });
  } else {
    steps.push({
      id: "conditions",
      kind: "condition",
      label: "No extra conditions",
      detail: "Always when trigger fires",
    });
  }

  steps.push({
    id: "logic",
    kind: "logic",
    label: "Run automation logic",
    detail: "Evaluate rule on worker — not in the browser",
  });

  input.actions.forEach((action, i) => {
    const type = String(action.type ?? "unknown");
    const gated = isOutboundAction(type);
    steps.push({
      id: `action_${i}`,
      kind: "action",
      label: `Action: ${type.replace(/_/g, " ")}`,
      actionType: type,
      gated,
      detail: gated ? "Outbound — approval required by default" : undefined,
    });
  });

  if (input.requiresApproval) {
    steps.push({
      id: "approval",
      kind: "approval",
      label: "Human approval gate",
      detail: "Outbound/publish actions wait for ApprovalRequest",
    });
  }

  steps.push({
    id: "outcome",
    kind: "outcome",
    label: "Record execution outcome",
    detail: "AutomationExecution status + result",
  });

  return steps;
}

export async function createRuleFromWorkflow(input: {
  organisationId: string;
  name: string;
  workflow: VisibleWorkflow;
  description?: string;
  isActive?: boolean;
}): Promise<string> {
  const wf = input.workflow;
  const invalid = validateAutomationRule({
    triggerType: wf.triggerType,
    actions: wf.actions,
    conditions: wf.conditions as Record<string, unknown> | null,
  });
  if (invalid) throw new Error(invalid);
  const row = await prisma.automationRule.create({
    data: {
      organisationId: input.organisationId,
      name: input.name.trim(),
      description: input.description ?? null,
      triggerType: wf.triggerType,
      conditions: wf.conditions as Prisma.InputJsonValue,
      actions: wf.actions as Prisma.InputJsonValue,
      workflow: wf as unknown as Prisma.InputJsonValue,
      naturalLanguageSource: wf.compiledFrom ?? null,
      requiresApproval: wf.requiresApproval,
      isActive: input.isActive ?? false, // NL rules start inactive until reviewed
    },
  });
  return row.id;
}

export async function createApprovalRequest(input: {
  organisationId: string;
  kind: string;
  title: string;
  summary?: string;
  automationRuleId?: string | null;
  payload: Record<string, unknown>;
}): Promise<string> {
  ensureBuiltinToolsRegistered();
  if (
    input.kind === "outbound_message" ||
    input.kind === "ai_outbound_message" ||
    input.kind === "publish"
  ) {
    const tool = input.kind === "publish" ? "social.publish" : "messaging.send";
    const policy = evaluateToolPolicy(tool, { organisationId: input.organisationId });
    if (policy.effect === "deny") {
      throw new Error(policy.reason || "Action denied by policy");
    }
  }

  const row = await prisma.approvalRequest.create({
    data: {
      organisationId: input.organisationId,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      automationRuleId: input.automationRuleId ?? null,
      payload: input.payload as Prisma.InputJsonValue,
      status: ApprovalRequestStatus.PENDING,
    },
  });
  return row.id;
}

export type AiOutboundApprovalPayload = {
  originalDraft: string;
  finalContent?: string;
  conversationId: string;
  contactId: string;
  contactExternalId: string;
  provider?: string;
  channel?: string;
  threadId?: string | null;
  source: "AI" | "FOLLOW_UP" | "AUTOMATION" | "MISSION" | "REACTIVATION";
  holder: string;
  idempotencyKey: string;
  agentVersion?: string;
  inboundMessageId?: string;
  followUpId?: string;
  leadId?: string;
  edited?: boolean;
  approvedByUserId?: string | null;
  approvedAt?: string;
  outboundDispatchId?: string;
  /**
   * Conversation activity version the draft was written against. Approve & Send refuses
   * (STALE_CONTEXT) if the customer or the team has written since.
   */
  expectedActivityVersion?: number;
  /** Booking offer + follow-ups to run once the approved reply is delivered. */
  followThrough?: import("@/services/messaging/ai-reply-follow-through").AiReplyFollowThrough;
};

/**
 * Retire pending AI reply drafts for a conversation. Used when a newer draft replaces
 * them (the customer wrote again) or a person replied by hand — otherwise owners could
 * approve outdated replies, or approve three drafts and send three answers.
 */
function draftVersion(payload: unknown): number | null {
  const v = (payload as { expectedActivityVersion?: unknown } | null)?.expectedActivityVersion;
  return typeof v === "number" ? v : null;
}

async function pendingAiDrafts(organisationId: string, conversationId: string) {
  return prisma.approvalRequest.findMany({
    where: {
      organisationId,
      kind: "ai_outbound_message",
      status: ApprovalRequestStatus.PENDING,
      payload: { path: ["conversationId"], equals: conversationId },
    },
    select: { id: true, payload: true },
  });
}

/**
 * Retire pending AI reply drafts for a conversation. Used when a newer draft replaces
 * them (the customer wrote again) or a person replied by hand — otherwise owners could
 * approve outdated replies, or approve three drafts and send three answers.
 * With `upToVersion`, only drafts written against that conversation version or earlier
 * are retired (never a newer one that finished first).
 */
export async function expirePendingAiDrafts(input: {
  organisationId: string;
  conversationId: string;
  reason: string;
  upToVersion?: number | null;
}): Promise<number> {
  const pending = await pendingAiDrafts(input.organisationId, input.conversationId);
  const ids = pending
    .filter((d) => {
      if (input.upToVersion == null) return true;
      const v = draftVersion(d.payload);
      return v === null || v <= input.upToVersion;
    })
    .map((d) => d.id);
  if (ids.length === 0) return 0;
  const result = await prisma.approvalRequest.updateMany({
    where: { id: { in: ids }, status: ApprovalRequestStatus.PENDING },
    data: {
      status: ApprovalRequestStatus.EXPIRED,
      decidedAt: new Date(),
      decisionNote: input.reason,
    },
  });
  return result.count;
}

/** Plain-English reason an approved message was not (or may not have been) sent. */
function approvalSendFailureReason(code: string): string {
  switch (code) {
    case "STALE_CONTEXT":
      return "Not sent — the conversation has moved on since this draft was written. Open it in the inbox and reply from there.";
    case "CONTACT_OPTED_OUT":
    case "CONTACT_SUPPRESSED":
      return "Not sent — this contact opted out.";
    case "DO_NOT_CONTACT":
      return "Not sent — this contact is marked do-not-contact.";
    case "CONTACT_NOT_FOUND":
      return "Not sent — this contact no longer exists.";
    case "CONVERSATION_NOT_FOUND":
      return "Not sent — this conversation no longer exists.";
    case "CONVERSATION_CLOSED":
      return "Not sent — this conversation is closed.";
    case "AI_PAUSED":
      return "Not sent — a person has taken over this conversation (AI is paused). Reply from the inbox.";
    case "MESSAGING_WINDOW_CLOSED":
      return "Not sent — the messaging window for this conversation has closed.";
    case "META_INSTAGRAM_NO_PRIOR_INBOUND":
    case "ZERNIO_NO_PRIOR_INBOUND":
      return "Not sent — Instagram only allows replies after the customer messages first.";
    case "PROVIDER_POLICY_BLOCKED":
      return "Not sent — blocked by the messaging platform's rules.";
    case "CONNECTION_REVOKED":
      return "Not sent — the messaging connection is disconnected. Reconnect it in Integrations, then reply from the inbox.";
    case "RECONCILIATION_REQUIRED":
      return "Delivery uncertain — the platform may have received this message. Check the conversation before sending anything else.";
    default:
      return `Not sent — the messaging platform rejected it${code ? ` (${code})` : ""}. Reply from the inbox instead.`;
  }
}

/** Queue an AI/automated social outbound for human Edit | Reject | Approve & Send. */
export async function createAiOutboundApprovalRequest(input: {
  organisationId: string;
  title: string;
  summary?: string;
  payload: AiOutboundApprovalPayload;
}): Promise<string> {
  // A new AI draft is written with the whole conversation in view, so it replaces earlier
  // drafts still waiting on the same conversation. When DMs arrive in a burst the replies
  // can finish out of order: a draft for an older message must never retire a newer one.
  if (input.payload.source === "AI" && input.payload.conversationId) {
    const version = draftVersion(input.payload);
    if (version !== null) {
      const pending = await pendingAiDrafts(input.organisationId, input.payload.conversationId);
      const newer = pending.find((d) => {
        const v = draftVersion(d.payload);
        return v !== null && v > version;
      });
      if (newer) return newer.id;
    }
    await expirePendingAiDrafts({
      organisationId: input.organisationId,
      conversationId: input.payload.conversationId,
      reason: "Replaced by a newer draft after the customer wrote again",
      upToVersion: version,
    });
  }
  return createApprovalRequest({
    organisationId: input.organisationId,
    kind: "ai_outbound_message",
    title: input.title,
    summary: input.summary ?? input.payload.originalDraft.slice(0, 280),
    payload: {
      ...input.payload,
      finalContent: input.payload.finalContent ?? input.payload.originalDraft,
      actionDescription: input.payload.originalDraft,
    },
  });
}

export async function decideApprovalRequest(input: {
  organisationId: string;
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedByUserId?: string | null;
  note?: string | null;
  /** Optional human edit applied before Approve & Send. */
  editedContent?: string | null;
}): Promise<{ status: ApprovalRequestStatus; payload: unknown; actionsRun: number }> {
  const existing = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalId, organisationId: input.organisationId },
  });
  if (!existing) throw new Error("Approval request not found");
  if (existing.status !== ApprovalRequestStatus.PENDING) {
    throw new Error(`Approval already ${existing.status}`);
  }

  const status =
    input.decision === "APPROVED"
      ? ApprovalRequestStatus.APPROVED
      : ApprovalRequestStatus.REJECTED;

  const payload = existing.payload as {
    context?: {
      organisationId: string;
      contactId?: string;
      conversationId?: string;
      leadId?: string;
      triggerType: string;
      payload?: Record<string, unknown>;
      approvalRequestId?: string;
      editedContent?: string;
    };
    actions?: Array<{ type: string; [key: string]: unknown }>;
  } & Partial<AiOutboundApprovalPayload>;

  if (
    status === ApprovalRequestStatus.APPROVED &&
    payload?.context &&
    Array.isArray(payload.actions)
  ) {
    if (payload.context.organisationId !== input.organisationId) {
      throw new Error(
        "Approval payload organisation mismatch — refusing to execute cross-tenant actions",
      );
    }
  }

  // Drafts queued before activity versions were recorded can't use the send-time stale
  // check, so refuse them if anyone has written in the conversation since they were made.
  if (
    existing.kind === "ai_outbound_message" &&
    status === ApprovalRequestStatus.APPROVED &&
    typeof payload.expectedActivityVersion !== "number" &&
    typeof payload.conversationId === "string"
  ) {
    const newer = await prisma.message.findFirst({
      where: {
        conversationId: payload.conversationId,
        organisationId: input.organisationId,
        createdAt: { gt: existing.createdAt },
      },
      select: { id: true },
    });
    if (newer) {
      const reason = approvalSendFailureReason("STALE_CONTEXT");
      await prisma.approvalRequest.updateMany({
        where: { id: existing.id, status: ApprovalRequestStatus.PENDING },
        data: {
          status: ApprovalRequestStatus.EXPIRED,
          decidedAt: new Date(),
          decidedByUserId: input.decidedByUserId ?? null,
          decisionNote: reason,
        },
      });
      throw new Error(reason);
    }
  }

  const editedTrimmed =
    typeof input.editedContent === "string" ? input.editedContent.trim() : "";
  let auditPayload: Prisma.InputJsonValue = existing.payload as Prisma.InputJsonValue;

  if (existing.kind === "ai_outbound_message" && status === ApprovalRequestStatus.APPROVED) {
    const originalDraft = String(payload.originalDraft || "");
    const finalContent =
      editedTrimmed ||
      String(payload.finalContent || payload.originalDraft || "").trim();
    if (!finalContent) {
      throw new Error("Cannot approve empty outbound message");
    }
    auditPayload = {
      ...(payload as Record<string, unknown>),
      originalDraft,
      finalContent,
      edited: finalContent !== originalDraft,
      approvedByUserId: input.decidedByUserId ?? null,
      approvedAt: new Date().toISOString(),
      actionDescription: finalContent,
    } as Prisma.InputJsonValue;
  } else if (editedTrimmed && status === ApprovalRequestStatus.APPROVED) {
    auditPayload = {
      ...(payload as Record<string, unknown>),
      finalContent: editedTrimmed,
      edited: true,
      approvedByUserId: input.decidedByUserId ?? null,
      approvedAt: new Date().toISOString(),
    } as Prisma.InputJsonValue;
  }

  // Claim the decision atomically: two approvers (or a double-click) used to both pass the
  // PENDING check above and both dispatch the message.
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id: existing.id, status: ApprovalRequestStatus.PENDING },
    data: {
      status,
      decidedByUserId: input.decidedByUserId ?? null,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
      payload: auditPayload,
    },
  });
  if (claimed.count === 0) {
    throw new Error("This approval was already decided — refresh to see the latest.");
  }

  let actionsRun = 0;
  if (status === ApprovalRequestStatus.APPROVED && existing.kind === "ai_outbound_message") {
    const p = auditPayload as unknown as AiOutboundApprovalPayload;
    const { dispatchOutboundMessage } = await import("@/services/messaging/outbound");
    const send = await dispatchOutboundMessage({
      organisationId: input.organisationId,
      conversationId: p.conversationId,
      contactId: p.contactId,
      contactExternalId: p.contactExternalId,
      content: p.finalContent || p.originalDraft,
      source: p.source,
      idempotencyKey: p.idempotencyKey,
      holder: p.holder,
      provider: p.provider,
      channel: p.channel ?? p.provider,
      threadId: p.threadId ?? undefined,
      agentVersion: p.agentVersion,
      actorId: input.decidedByUserId ?? undefined,
      expectedActivityVersion:
        typeof p.expectedActivityVersion === "number" ? p.expectedActivityVersion : undefined,
      metadata: {
        approvalRequestId: existing.id,
        originalDraft: p.originalDraft,
        finalContent: p.finalContent || p.originalDraft,
        approvedByUserId: input.decidedByUserId ?? null,
        provider: p.provider,
        conversationId: p.conversationId,
        followUpId: p.followUpId,
        inboundMessageId: p.inboundMessageId,
      },
    });
    // ALREADY_CONFIRMED: this exact draft was delivered before (idempotency) — not a failure.
    // IDEMPOTENT_RACE: another request is delivering this same draft right now.
    if (!send.ok && send.code !== "ALREADY_CONFIRMED" && send.code !== "IDEMPOTENT_RACE") {
      const code = typeof send.code === "string" ? send.code : "";
      // The row was marked APPROVED before sending; never leave it "approved" with nothing
      // sent. A retry reuses this draft's idempotency key and would hit the same recorded
      // outcome forever, so every failure except a momentary lease clash is final.
      if (code === "LEASE_UNAVAILABLE") {
        await prisma.approvalRequest.update({
          where: { id: existing.id },
          data: { status: ApprovalRequestStatus.PENDING, decidedAt: null, decidedByUserId: null },
        });
        throw new Error(
          "Another message is being sent to this conversation right now — the draft is still waiting; try again in a moment.",
        );
      }
      const reason = approvalSendFailureReason(code);
      await prisma.approvalRequest.update({
        where: { id: existing.id },
        data: { status: ApprovalRequestStatus.EXPIRED, decisionNote: reason },
      });
      throw new Error(reason);
    }
    actionsRun = 1;
    await prisma.approvalRequest.update({
      where: { id: existing.id },
      data: {
        payload: {
          ...(p as Record<string, unknown>),
          outboundDispatchId: send.dispatch?.id ?? null,
          outboundMessageId: send.dispatch?.messageId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
    if (p.followUpId) {
      await prisma.followUp.updateMany({
        where: {
          id: p.followUpId,
          organisationId: input.organisationId,
        },
        data: {
          status: FollowUpStatus.SENT,
          sentAt: new Date(),
          cancelReason: null,
        },
      });
    }
    // Same follow-through as a directly sent AI reply: record the booking offer and
    // schedule follow-ups. Skipped on an idempotent replay — it already ran then.
    if (send.ok && p.followThrough) {
      const { runAiReplyFollowThrough } = await import(
        "@/services/messaging/ai-reply-follow-through"
      );
      await runAiReplyFollowThrough({
        organisationId: input.organisationId,
        contactId: p.contactId,
        conversationId: p.conversationId,
        leadId: p.leadId ?? null,
        plan: p.followThrough,
      }).catch((error) => {
        // The message is already delivered — never report the approval as failed.
        logger.warn("Approval follow-through after send failed", {
          approvalRequestId: existing.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    }
  } else if (
    status === ApprovalRequestStatus.APPROVED &&
    payload?.context &&
    Array.isArray(payload.actions)
  ) {
    const { executeAction } = await import("@/services/automations");
    for (const action of payload.actions) {
      const actionWithEdit =
        editedTrimmed && (action.type === "send_message" || action.type === "send_booking_link")
          ? { ...action, message: editedTrimmed }
          : action;
      await executeAction(actionWithEdit as never, {
        ...payload.context,
        approvalRequestId: existing.id,
        editedContent: editedTrimmed || undefined,
      });
      actionsRun += 1;
    }
  }

  return { status, payload: auditPayload, actionsRun };
}
