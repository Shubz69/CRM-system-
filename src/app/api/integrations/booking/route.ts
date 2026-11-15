import { NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  getOrganisationBookingSecret,
  globalBookingSecretAccepted,
  regenerateOrganisationBookingSecret,
} from "@/services/booking-secrets";
import { maskSecret } from "@/services/manychat-secrets";

function webhookUrls() {
  const base = (getEnv().APP_URL || "").replace(/\/$/, "");
  return {
    generic: `${base}/api/webhooks/booking`,
    calendly: `${base}/api/integrations/booking/calendly/webhook`,
    calcom: `${base}/api/integrations/booking/calcom/webhook`,
  };
}

export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const secret = await getOrganisationBookingSecret(session.organisationId);
    return Response.json({
      organisationId: session.organisationId,
      secretConfigured: Boolean(secret),
      secretMasked: maskSecret(secret),
      sharedSecretAccepted: !secret && globalBookingSecretAccepted(),
      header: "x-booking-secret",
      webhookUrls: webhookUrls(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const postSchema = z.object({ action: z.literal("regenerate_secret") });

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    postSchema.parse(await req.json());
    const secret = await regenerateOrganisationBookingSecret(session.organisationId);
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "integration.booking.secret_regenerated",
      entityType: "Integration",
      entityId: session.organisationId,
    });
    // Shown once — only the masked form is ever returned again.
    return Response.json({ ok: true, secret, secretMasked: maskSecret(secret) });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
