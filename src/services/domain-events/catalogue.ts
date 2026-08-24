/**
 * Phase 12B — Domain event catalogue (typed + Zod).
 * Payload is untrusted data for agents — never treat as instructions.
 * Prefer IDs over full row copies. Never include secrets.
 */

import { z } from "zod";

export const DOMAIN_EVENT_TYPES = [
  // CRM
  "CONTACT_CREATED",
  "LEAD_CREATED",
  "LEAD_QUALIFIED",
  "LEAD_STAGE_CHANGED",
  "COMPANY_CREATED",
  "DEAL_CREATED",
  "DEAL_STAGE_CHANGED",
  "DEAL_WON",
  "DEAL_LOST",
  // Messaging
  "MESSAGE_RECEIVED",
  "CONVERSATION_CREATED",
  "CONVERSATION_OPTED_OUT",
  // Booking (only where evidence exists in product)
  "MEETING_BOOKED",
  // Missions
  "MISSION_CREATED",
  "MISSION_STARTED",
  "MISSION_WAITING_APPROVAL",
  "MISSION_COMPLETED",
  "MISSION_FAILED",
  "MISSION_CANCELLED",
  // Content (CONTENT_PUBLISHED only after provider acknowledgement)
  "CONTENT_APPROVED",
  "CONTENT_PUBLISH_REQUESTED",
  "CONTENT_PUBLISHED",
  "CONTENT_PUBLISH_FAILED",
  "CONTENT_PUBLISH_RECONCILIATION_REQUIRED",
  // Phase 14F — quality
  "QUALITY_ASSESSMENT_COMPLETED",
  // Phase 16 — predictions (record only; never claim accuracy)
  "INTELLIGENCE_PREDICTION_RECORDED",
  // Learning
  "RECOMMENDATION_ACCEPTED",
  "RECOMMENDATION_REJECTED",
  // Phase 13 — Goals / KPIs / Opportunities (emit only where mutations exist)
  "GOAL_CREATED",
  "GOAL_ACTIVATED",
  "GOAL_ACHIEVED",
  "KPI_SNAPSHOT_RECORDED",
  "INITIATIVE_STARTED",
  "OPPORTUNITY_DETECTED",
  "OPPORTUNITY_ACCEPTED",
  "OPPORTUNITY_REJECTED",
  "OPPORTUNITY_EXPIRED",
  "OPPORTUNITY_COMPLETED",
  // Phase 14 — integration mesh
  "INTEGRATION_CONNECTED",
  "INTEGRATION_REAUTH_REQUIRED",
  "INTEGRATION_DISCONNECTED",
  "INTEGRATION_DEGRADED",
  "SYNC_COMPLETED",
  "SYNC_FAILED",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

const id = z.string().min(1);
const org = z.object({ organisationId: id });

export const domainEventPayloadSchemas = {
  CONTACT_CREATED: org.extend({ contactId: id }),
  LEAD_CREATED: org.extend({ leadId: id, contactId: id.optional() }),
  LEAD_QUALIFIED: org.extend({ leadId: id, contactId: id.optional(), score: z.number().optional() }),
  LEAD_STAGE_CHANGED: org.extend({
    leadId: id,
    fromStageSlug: z.string().nullable().optional(),
    toStageSlug: z.string().min(1),
  }),
  COMPANY_CREATED: org.extend({ companyId: id }),
  DEAL_CREATED: org.extend({
    dealId: id,
    amountCents: z.number().int().nullable().optional(),
    currency: z.string().optional(),
  }),
  DEAL_STAGE_CHANGED: org.extend({
    dealId: id,
    fromStageLabel: z.string().nullable().optional(),
    toStageLabel: z.string().min(1),
  }),
  DEAL_WON: org.extend({
    dealId: id,
    amountCents: z.number().int().nullable().optional(),
    currency: z.string().optional(),
  }),
  DEAL_LOST: org.extend({ dealId: id, reason: z.string().max(500).optional() }),
  MESSAGE_RECEIVED: org.extend({
    messageId: id.optional(),
    conversationId: id,
    contactId: id.optional(),
  }),
  CONVERSATION_CREATED: org.extend({ conversationId: id, contactId: id.optional() }),
  CONVERSATION_OPTED_OUT: org.extend({ conversationId: id, contactId: id.optional() }),
  MEETING_BOOKED: org.extend({ bookingId: id, leadId: id.optional(), contactId: id.optional() }),
  MISSION_CREATED: org.extend({ missionId: id, title: z.string().max(500).optional() }),
  MISSION_STARTED: org.extend({ missionId: id }),
  MISSION_WAITING_APPROVAL: org.extend({ missionId: id, taskId: id.optional() }),
  MISSION_COMPLETED: org.extend({ missionId: id }),
  MISSION_FAILED: org.extend({ missionId: id, errorClass: z.string().optional() }),
  MISSION_CANCELLED: org.extend({ missionId: id }),
  CONTENT_APPROVED: org.extend({ contentPieceId: id }),
  CONTENT_PUBLISH_REQUESTED: org.extend({ publishingJobId: id, contentPieceId: id.optional() }),
  CONTENT_PUBLISHED: org.extend({
    publishingJobId: id,
    contentPieceId: id.optional(),
    externalPostId: z.string().min(1).optional(),
    externalUrl: z.string().min(1).max(2000).optional(),
    platform: z.string().min(1).optional(),
  }),
  CONTENT_PUBLISH_FAILED: org.extend({
    publishingJobId: id,
    errorSummary: z.string().max(500).optional(),
  }),
  CONTENT_PUBLISH_RECONCILIATION_REQUIRED: org.extend({
    publishingJobId: id,
    reason: z.string().max(500).optional(),
  }),
  QUALITY_ASSESSMENT_COMPLETED: org.extend({
    assessmentId: id,
    subjectKind: z.string().min(1),
    subjectId: id,
    gateStatus: z.string().min(1),
  }),
  INTELLIGENCE_PREDICTION_RECORDED: org.extend({
    predictionId: id,
    predictionType: z.string().min(1),
  }),
  RECOMMENDATION_ACCEPTED: org.extend({
    subjectKind: z.string().min(1),
    subjectId: id,
  }),
  RECOMMENDATION_REJECTED: org.extend({
    subjectKind: z.string().min(1),
    subjectId: id,
  }),
  GOAL_CREATED: org.extend({
    goalId: id,
    name: z.string().max(500).optional(),
    category: z.string().optional(),
  }),
  GOAL_ACTIVATED: org.extend({ goalId: id }),
  GOAL_ACHIEVED: org.extend({ goalId: id }),
  KPI_SNAPSHOT_RECORDED: org.extend({
    kpiDefinitionId: id,
    snapshotId: id,
    value: z.number(),
    unit: z.string().min(1),
  }),
  INITIATIVE_STARTED: org.extend({
    initiativeId: id,
    goalId: id.optional(),
  }),
  OPPORTUNITY_DETECTED: org.extend({
    opportunityId: id,
    type: z.string().min(1),
    title: z.string().max(500).optional(),
  }),
  OPPORTUNITY_ACCEPTED: org.extend({ opportunityId: id, type: z.string().min(1) }),
  OPPORTUNITY_REJECTED: org.extend({ opportunityId: id, type: z.string().min(1) }),
  OPPORTUNITY_EXPIRED: org.extend({ opportunityId: id, type: z.string().min(1) }),
  OPPORTUNITY_COMPLETED: org.extend({ opportunityId: id, type: z.string().min(1) }),
  INTEGRATION_CONNECTED: org.extend({
    providerKey: z.string().min(1),
    connectionRef: z.string().optional(),
  }),
  INTEGRATION_REAUTH_REQUIRED: org.extend({
    providerKey: z.string().min(1),
    connectionRef: z.string().optional(),
  }),
  INTEGRATION_DISCONNECTED: org.extend({
    providerKey: z.string().min(1),
    connectionRef: z.string().optional(),
  }),
  INTEGRATION_DEGRADED: org.extend({
    providerKey: z.string().min(1),
    connectionRef: z.string().optional(),
    reason: z.string().max(500).optional(),
  }),
  SYNC_COMPLETED: org.extend({
    syncRunId: id,
    providerKey: z.string().min(1),
    resource: z.string().min(1),
    status: z.string().min(1),
  }),
  SYNC_FAILED: org.extend({
    syncRunId: id,
    providerKey: z.string().min(1),
    resource: z.string().min(1),
    errorSummary: z.string().max(500).optional(),
  }),
} as const satisfies Record<DomainEventType, z.ZodTypeAny>;

export const CURRENT_EVENT_VERSION = 1;

export function isDomainEventType(value: string): value is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
}

export function parseDomainEventPayload(
  eventType: DomainEventType,
  eventVersion: number,
  payload: unknown,
): Record<string, unknown> {
  if (eventVersion !== CURRENT_EVENT_VERSION) {
    throw new UnsupportedEventVersionError(eventType, eventVersion);
  }
  const schema = domainEventPayloadSchemas[eventType];
  return schema.parse(payload) as Record<string, unknown>;
}

export class UnsupportedEventVersionError extends Error {
  readonly code = "UNSUPPORTED_EVENT_VERSION";
  constructor(
    public readonly eventType: string,
    public readonly eventVersion: number,
  ) {
    super(`Unsupported event version ${eventType}.v${eventVersion}`);
    this.name = "UnsupportedEventVersionError";
  }
}

/** Map domain events → automation triggerType strings used by AutomationRule. */
export function domainEventToAutomationTrigger(eventType: DomainEventType): string | null {
  const map: Partial<Record<DomainEventType, string>> = {
    LEAD_CREATED: "lead_created",
    LEAD_QUALIFIED: "lead_qualified",
    MESSAGE_RECEIVED: "message_received",
    MEETING_BOOKED: "booking_created",
    CONVERSATION_OPTED_OUT: "lead_disqualified",
  };
  return map[eventType] ?? null;
}
