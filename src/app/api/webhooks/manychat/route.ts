import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { assertWebhookSecretsConfigured, isDemoModeEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { manychatWebhookSchema } from "@/schemas/webhook";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { prisma } from "@/lib/db";
import { resolveManyChatWebhookOrganisation } from "@/services/manychat-secrets";
import { recordUsage } from "@/services/usage";

export async function POST(req: NextRequest) {
  try {
    assertWebhookSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`manychat:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const secretHeader =
      req.headers.get("x-manychat-secret") ||
      req.headers.get("x-webhook-secret") ||
      "";

    const body = await req.json();
    const parsed = manychatWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const data = parsed.data;
    const resolved = await resolveManyChatWebhookOrganisation({
      secretHeader,
      payloadOrganisationId: data.organisationId,
      channelExternalId: data.channel_id,
      allowDemoFallback: isDemoModeEnabled(),
    });

    if (!resolved.ok) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }

    let organisationId = resolved.organisationId;
    let channelExternalId = resolved.channelExternalId;

    if (!channelExternalId) {
      const channel = await prisma.messagingChannel.findFirst({
        where: { organisationId, provider: "manychat", isActive: true },
        orderBy: { createdAt: "asc" },
      });
      channelExternalId = channel?.externalId ?? undefined;
    }

    const subscriberId = data.subscriber_id ? String(data.subscriber_id) : undefined;
    const text = data.text || data.message;
    if (!subscriberId || !text) {
      return Response.json({ error: "subscriber_id and text/message are required" }, { status: 400 });
    }

    const fullName =
      data.name ||
      [data.first_name, data.last_name].filter(Boolean).join(" ") ||
      data.ig_username;

    const idempotencySeed = JSON.stringify({
      id: data.id,
      subscriberId,
      text,
      thread: data.thread_id,
    });

    const result = await processInboundMessage(
      {
        organisationId,
        channelExternalId,
        idempotencyKey: data.id || createHash("sha256").update(idempotencySeed).digest("hex"),
        contact: {
          externalId: subscriberId,
          fullName,
          instagramUsername: data.ig_username,
          email: data.email,
          phone: data.phone,
        },
        message: { text, externalId: data.id },
        threadId: data.thread_id,
        campaignSource: data.campaign,
        leadSource: "instagram_manychat",
      },
      { provider: "manychat", rawPayload: body },
    );

    await recordUsage({
      organisationId,
      feature: "webhook_inbound",
      provider: "manychat",
      metadata: { duplicate: result.duplicate, authMethod: resolved.authMethod },
    });

    return Response.json({ ok: true, result });
  } catch (error) {
    logger.error("ManyChat webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
