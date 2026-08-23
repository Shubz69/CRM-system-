/**
 * Phase 8 Automation OS — NL → visible workflow compile + approval gates.
 * Deterministic compile (no invented capabilities). Outbound stays approval-gated.
 */

import { ApprovalRequestStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureBuiltinToolsRegistered, evaluateToolPolicy } from "@/kernel";

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
 * Compile natural language into a visible workflow. Only known triggers/actions.
 */
export function compileNaturalLanguageToWorkflow(nl: string): VisibleWorkflow {
  const text = nl.trim();
  if (!text) throw new Error("Natural language is required");

  const lower = text.toLowerCase();
  let triggerType = "lead_created";
  if (lower.includes("qualified") || lower.includes("qualification")) {
    triggerType = "lead_qualified";
  } else if (lower.includes("inactive") || lower.includes("no reply") || lower.includes("follow")) {
    triggerType = "conversation_inactive";
  } else if (lower.includes("booking") || lower.includes("booked")) {
    triggerType = "booking_created";
  } else if (lower.includes("message") || lower.includes("inbound") || lower.includes("dm")) {
    triggerType = "message_received";
  } else if (lower.includes("disqualified")) {
    triggerType = "lead_disqualified";
  }

  const conditions: Record<string, unknown> = {};
  const scoreMatch = lower.match(/score\s*(>=|>|above)\s*(\d+)/);
  if (scoreMatch) conditions.minScore = Number(scoreMatch[2]);
  const minutesMatch = lower.match(/(\d+)\s*min/);
  if (minutesMatch && triggerType === "conversation_inactive") {
    conditions.minutes = Number(minutesMatch[1]);
  }

  const actions: Array<Record<string, unknown>> = [];
  if (lower.includes("pause ai") || lower.includes("handover") || lower.includes("hand over")) {
    actions.push({ type: "handover" });
  }
  if (lower.includes("notify") || lower.includes("alert")) {
    actions.push({ type: "notify_team", message: "Automation alert from NL rule" });
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
  }

  const requiresApproval = actions.some((a) => isOutboundAction(String(a.type)));
  const steps = buildWorkflowSteps({
    triggerType,
    conditions,
    actions,
    requiresApproval,
  });

  return {
    version: 1,
    triggerType,
    conditions,
    actions,
    steps,
    requiresApproval,
    compiledFrom: text.slice(0, 2000),
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
  if (input.kind === "outbound_message" || input.kind === "publish") {
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

export async function decideApprovalRequest(input: {
  organisationId: string;
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedByUserId?: string | null;
  note?: string | null;
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
    };
    actions?: Array<{ type: string; [key: string]: unknown }>;
  };

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

  await prisma.approvalRequest.update({
    where: { id: existing.id },
    data: {
      status,
      decidedByUserId: input.decidedByUserId ?? null,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
    },
  });

  let actionsRun = 0;
  if (
    status === ApprovalRequestStatus.APPROVED &&
    payload?.context &&
    Array.isArray(payload.actions)
  ) {
    const { executeAction } = await import("@/services/automations");
    for (const action of payload.actions) {
      await executeAction(action as never, payload.context);
      actionsRun += 1;
    }
  }

  return { status, payload: existing.payload, actionsRun };
}
