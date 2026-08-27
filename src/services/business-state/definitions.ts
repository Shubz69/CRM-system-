import { prisma } from "@/lib/db";

export type StateDefinitionSeed = {
  entityType: string;
  dimension: string;
  label: string;
  description: string;
  valueDomain: { values: string[] };
  calculatorKey: string;
};

export const STATE_DEFINITIONS: readonly StateDefinitionSeed[] = [
  {
    entityType: "DEAL",
    dimension: "URGENCY",
    label: "Deal urgency",
    description: "Time pressure inferred from inactivity, latency, and close timing.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"] },
    calculatorKey: "deal_urgency_v1",
  },
  {
    entityType: "DEAL",
    dimension: "RISK",
    label: "Deal risk",
    description: "Deterministic risk band from inactivity, response latency, and engagement.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"] },
    calculatorKey: "deal_risk_v1",
  },
  {
    entityType: "DEAL",
    dimension: "BUYING_STAGE",
    label: "Buying stage",
    description: "Normalised CRM buying stage.",
    valueDomain: {
      values: ["DISCOVERY", "EVALUATION", "NEGOTIATION", "COMMITMENT", "UNKNOWN"],
    },
    calculatorKey: "deal_buying_stage_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "INTENT",
    label: "Contact intent",
    description: "Intent inferred from engagement movement and positive signals.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] },
    calculatorKey: "contact_intent_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "RELATIONSHIP",
    label: "Relationship",
    description: "Relationship strength from recency, latency, and touch count.",
    valueDomain: { values: ["WEAK", "DEVELOPING", "STRONG", "UNKNOWN"] },
    calculatorKey: "contact_relationship_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "FIT",
    label: "Contact fit",
    description: "Fit band from an explicit deterministic fit score.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] },
    calculatorKey: "contact_fit_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "QUALIFICATION",
    label: "Qualification",
    description: "Messaging qualification posture from structured answers.",
    valueDomain: {
      values: [
        "QUALIFIED",
        "POTENTIALLY_QUALIFIED",
        "NEEDS_INFORMATION",
        "NOT_QUALIFIED",
        "UNKNOWN",
      ],
    },
    calculatorKey: "contact_qualification_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "BUYING_STAGE",
    label: "Buying stage",
    description: "Buying stage inferred from conversation understanding.",
    valueDomain: {
      values: ["DISCOVERY", "EVALUATION", "NEGOTIATION", "COMMITMENT", "UNKNOWN"],
    },
    calculatorKey: "contact_buying_stage_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "URGENCY",
    label: "Contact urgency",
    description: "Urgency inferred from messaging cadence and intent.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"] },
    calculatorKey: "contact_urgency_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "ENGAGEMENT",
    label: "Contact engagement",
    description: "Engagement from inbound/outbound messaging activity.",
    valueDomain: { values: ["DECLINING", "STABLE", "GROWING", "UNKNOWN"] },
    calculatorKey: "contact_engagement_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "RISK",
    label: "Contact risk",
    description: "Risk from objections, stalls, and disengagement signals.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"] },
    calculatorKey: "contact_risk_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "REACTIVATION_POSTURE",
    label: "Reactivation posture",
    description: "Whether reactivation is appropriate for a quiet contact.",
    valueDomain: { values: ["NONE", "SOFT", "ACTIVE", "BLOCKED", "UNKNOWN"] },
    calculatorKey: "contact_reactivation_v1",
  },
  {
    entityType: "CONTACT",
    dimension: "MEETING_READINESS",
    label: "Meeting readiness",
    description: "Readiness to offer or book a meeting from messaging evidence.",
    valueDomain: { values: ["NOT_READY", "INTERESTED", "READY", "BOOKED", "UNKNOWN"] },
    calculatorKey: "contact_meeting_readiness_v1",
  },
  {
    entityType: "CHANNEL",
    dimension: "ENGAGEMENT",
    label: "Channel engagement",
    description: "Engagement direction from observed rate and change.",
    valueDomain: { values: ["DECLINING", "STABLE", "GROWING", "UNKNOWN"] },
    calculatorKey: "channel_engagement_v1",
  },
  {
    entityType: "CHANNEL",
    dimension: "SATURATION",
    label: "Channel saturation",
    description: "Saturation band from observed saturation rate.",
    valueDomain: { values: ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] },
    calculatorKey: "channel_saturation_v1",
  },
  {
    entityType: "CHANNEL",
    dimension: "CHANNEL_STRENGTH",
    label: "Channel strength",
    description: "Combined engagement, growth, and saturation strength.",
    valueDomain: { values: ["WEAK", "MODERATE", "STRONG", "UNKNOWN"] },
    calculatorKey: "channel_strength_v1",
  },
] as const;

export function getStateDefinition(entityType: string, dimension: string) {
  return STATE_DEFINITIONS.find(
    (definition) =>
      definition.entityType === entityType.toUpperCase() &&
      definition.dimension === dimension.toUpperCase(),
  );
}

export async function ensureStateDefinitions() {
  return Promise.all(
    STATE_DEFINITIONS.map((definition) =>
      prisma.stateDefinition.upsert({
        where: {
          entityType_dimension: {
            entityType: definition.entityType,
            dimension: definition.dimension,
          },
        },
        create: { ...definition, active: true },
        update: {
          label: definition.label,
          description: definition.description,
          valueDomain: definition.valueDomain,
          calculatorKey: definition.calculatorKey,
          active: true,
        },
      }),
    ),
  );
}
