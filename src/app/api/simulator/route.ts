import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermissionForMutation, jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { logger } from "@/lib/logger";

const simulatorSchema = z.object({
  text: z.string().trim().min(1, "Type a message to simulate."),
  contactExternalId: z.string().min(1).default("sim_lead_001"),
  fullName: z.string().optional(),
  instagramUsername: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  campaignSource: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const SIMULATOR_FIELD_LABELS: Record<string, string> = {
  text: "Message",
  contactExternalId: "Contact id",
  fullName: "Name",
  instagramUsername: "Instagram username",
  email: "Email",
  campaignSource: "Campaign source",
  idempotencyKey: "Idempotency key",
};

/** One readable sentence for the first problem — never zod's raw issue JSON. */
function readableSimulatorError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Check the simulator message and try again.";
  const field = String(issue.path[0] ?? "");
  if (field === "text" && (issue.code === "too_small" || issue.code === "too_big")) {
    return issue.message;
  }
  if (field === "email") return "Enter a valid email address or leave it empty.";
  const label = SIMULATOR_FIELD_LABELS[field] ?? "Input";
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return field === "text" ? "Type a message to simulate." : `${label} is required.`;
  }
  return `${label} is invalid.`;
}

/**
 * Org-scoped conversation simulator — available to any signed-in member with
 * inbox:write. Creates real CRM rows marked origin/leadSource = "simulator".
 */
export async function POST(req: NextRequest) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return jsonError("Invalid request body.", 400);
    }
    const session = await requirePermissionForMutation(
      "inbox:write",
      req,
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null,
    );
    const parsed = simulatorSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(readableSimulatorError(parsed.error), 400);
    }

    const data = parsed.data;
    // Simulated leads live in their own "sim_" namespace. Typing a real ManyChat
    // subscriber id here used to attach the test message to that real customer — and the
    // AI reply could then be delivered to them through the live channel.
    const contactExternalId = data.contactExternalId.startsWith("sim_")
      ? data.contactExternalId
      : `sim_${data.contactExternalId}`;
    const result = await processInboundMessage(
      {
        organisationId: session.organisationId,
        idempotencyKey: data.idempotencyKey,
        contact: {
          externalId: contactExternalId,
          fullName: data.fullName ?? "Simulated Lead",
          instagramUsername: data.instagramUsername ?? "sim_lead",
          // Not passed on: the pipeline matches contacts by email, which would attach a
          // simulated conversation to a real customer with that address.
        },
        message: {
          text: data.text,
          externalId: `sim_${Date.now()}`,
        },
        threadId: `sim_thread_${contactExternalId}`,
        campaignSource: data.campaignSource ?? "simulator",
        leadSource: "simulator",
      },
      { provider: "simulator", rawPayload: { ...data, origin: "simulator" } },
    );

    return Response.json({ ok: true, result });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Simulator failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) {
      return jsonError("You don't have permission to use the simulator.", 403);
    }
    logger.error("Simulator error", { message });
    return jsonError(
      "The simulator could not process that message. Try again or check agent settings.",
      500,
    );
  }
}
