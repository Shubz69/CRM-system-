import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { logger } from "@/lib/logger";

const simulatorSchema = z.object({
  text: z.string().min(1),
  contactExternalId: z.string().min(1).default("sim_lead_001"),
  fullName: z.string().optional(),
  instagramUsername: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  campaignSource: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

/**
 * Org-scoped conversation simulator — available to any signed-in member with
 * inbox:write. Creates real CRM rows marked origin/leadSource = "simulator".
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("inbox:write");
    const body = await req.json();
    const parsed = simulatorSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.message, 400);
    }

    const data = parsed.data;
    const result = await processInboundMessage(
      {
        organisationId: session.organisationId,
        idempotencyKey: data.idempotencyKey,
        contact: {
          externalId: data.contactExternalId,
          fullName: data.fullName ?? "Simulated Lead",
          instagramUsername: data.instagramUsername ?? "sim_lead",
          email: data.email || undefined,
        },
        message: {
          text: data.text,
          externalId: `sim_${Date.now()}`,
        },
        threadId: `sim_thread_${data.contactExternalId}`,
        campaignSource: data.campaignSource ?? "simulator",
        leadSource: "simulator",
      },
      { provider: "simulator", rawPayload: { ...data, origin: "simulator" } },
    );

    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Simulator failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    logger.error("Simulator error", { message });
    return jsonError(
      "The simulator could not process that message. Try again or check agent settings.",
      500,
    );
  }
}
