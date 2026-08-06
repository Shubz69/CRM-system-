import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { getEnv, assertWebhookSecretsConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { manychatWebhookSchema } from "@/schemas/webhook";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { prisma } from "@/lib/db";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST(req: NextRequest) {
  try {
    assertWebhookSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`manychat:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    const secretHeader =
      req.headers.get("x-manychat-secret") ||
      req.headers.get("x-webhook-secret") ||
      "";

    if (!safeEqual(secretHeader, env.MANYCHAT_WEBHOOK_SECRET)) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const body = await req.json();
    const parsed = manychatWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const data = parsed.data;
    let organisationId = data.organisationId;

    if (!organisationId) {
      // Resolve via messaging channel external id when available; never fall back to "first org" silently.
      const channelId = typeof body.channel_id === "string" ? body.channel_id : undefined;
      if (channelId) {
        const channel = await prisma.messagingChannel.findFirst({
          where: { provider: "manychat", externalId: channelId, isActive: true },
        });
        organisationId = channel?.organisationId;
      }
    }

    if (!organisationId && process.env.NODE_ENV !== "production") {
      const org = await prisma.organisation.findFirst({
        where: { deletedAt: null, demoData: true },
        orderBy: { createdAt: "asc" },
      });
      organisationId = org?.id;
    }

    if (!organisationId) {
      return Response.json(
        { error: "organisationId required (or map channel_id to an organisation)" },
        { status: 400 },
      );
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

    return Response.json({ ok: true, result });
  } catch (error) {
    logger.error("ManyChat webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
