/**
 * Messaging → Business State / Process Twin hooks (Phase 20 integration).
 * No second Messaging State Engine.
 */

import { applyStateUpdate } from "@/services/business-state";
import { applyProcessEvent, ensureProcessDefinitions } from "@/services/process-twin";
import { isIntelligenceFlagEnabled } from "@/services/intelligence-flags";

const SALES_PROCESS = "sales_conversation";

/** Ensure messaging funnel process exists (extends Phase 20F builtins at runtime). */
export async function ensureMessagingProcessDefinition() {
  await ensureProcessDefinitions();
  // sales_conversation may be applied via applyProcessEvent even if not in BUILTIN list —
  // process twin upserts by key when ProcessDefinition exists; seed if missing via raw create attempt.
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.processDefinition.upsert({
      where: { processKey: SALES_PROCESS },
      create: {
        processKey: SALES_PROCESS,
        label: "Sales conversation",
        description: "Inbound → response → qualification → meeting → deal",
        stages: [
          "INBOUND",
          "FIRST_RESPONSE",
          "QUALIFICATION",
          "MEETING_OFFERED",
          "MEETING_BOOKED",
          "DEAL",
          "WON",
          "LOST",
        ],
        active: true,
      },
      update: { active: true, label: "Sales conversation" },
    });
  } catch {
    // ProcessDefinition table may be unavailable in unit tests
  }
}

export async function onInboundMessageStateHooks(input: {
  organisationId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  intent?: string | null;
  urgency?: string | null;
}) {
  const enabled = await isIntelligenceFlagEnabled(
    input.organisationId,
    "businessStateEnabled",
  );
  if (!enabled) return;

  if (input.intent) {
    await applyStateUpdate({
      organisationId: input.organisationId,
      entityType: "CONTACT",
      entityId: input.contactId,
      dimension: "INTENT",
      value: String(input.intent).slice(0, 64).toUpperCase(),
      reasonCode: "MESSAGE_RECEIVED",
      evidenceLinks: [
        { evidenceKind: "Message", evidenceId: input.messageId },
      ],
      triggeredByEventId: input.messageId,
    }).catch(() => undefined);
  }

  await applyProcessEvent({
    organisationId: input.organisationId,
    processKey: SALES_PROCESS,
    fromStage: "INBOUND",
    toStage: "FIRST_RESPONSE",
  }).catch(() => undefined);
}

export async function onQualificationStateHooks(input: {
  organisationId: string;
  contactId: string;
  status: string;
  leadId?: string;
}) {
  const enabled = await isIntelligenceFlagEnabled(
    input.organisationId,
    "businessStateEnabled",
  );
  if (!enabled) return;
  await applyStateUpdate({
    organisationId: input.organisationId,
    entityType: "CONTACT",
    entityId: input.contactId,
    dimension: "QUALIFICATION",
    value: input.status.toUpperCase(),
    reasonCode: "QUALIFICATION_UPDATED",
    evidenceLinks: input.leadId
      ? [{ evidenceKind: "Lead", evidenceId: input.leadId }]
      : undefined,
  }).catch(() => undefined);

  await applyProcessEvent({
    organisationId: input.organisationId,
    processKey: SALES_PROCESS,
    fromStage: "FIRST_RESPONSE",
    toStage: "QUALIFICATION",
  }).catch(() => undefined);
}
