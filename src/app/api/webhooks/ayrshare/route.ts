import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Ayrshare webhooks — tenant-scoped via profileKey → AyrshareProfile.
 * No new BullMQ worker; durable via DomainEvent outbox when organisation resolved.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`ayrshare:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    const secret = env.AYRSHARE_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return Response.json(
        { ok: false, code: "AYRSHARE_NOT_CONFIGURED", error: "Ayrshare webhook secret not configured" },
        { status: 503 },
      );
    }

    const headerSecret =
      req.headers.get("x-ayrshare-secret") ||
      req.headers.get("x-webhook-secret") ||
      "";
    if (!safeEqual(headerSecret, secret)) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const rawBody = await req.text();
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");

    let payload: {
      action?: string;
      profileKey?: string;
      platform?: string;
      id?: string;
      [key: string]: unknown;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const profileKey = typeof payload.profileKey === "string" ? payload.profileKey : null;
    if (!profileKey) {
      // Ack without tenant mutation — fail closed on unknown profile
      logger.warn("Ayrshare webhook missing profileKey", { payloadHash: payloadHash.slice(0, 12) });
      return Response.json({ ok: true, ignored: true, reason: "missing_profile_key" });
    }

    const profile = await prisma.ayrshareProfile.findFirst({
      where: { ayrshareProfileId: profileKey },
    });
    if (!profile) {
      logger.warn("Ayrshare webhook unknown profile", { payloadHash: payloadHash.slice(0, 12) });
      return Response.json({ ok: true, ignored: true, reason: "unknown_profile" });
    }

    const action = String(payload.action || "ayrshare.event");
    const dedupeKey = `ayrshare:${profile.organisationId}:${action}:${payloadHash}`;

    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: profile.organisationId,
        eventType: "INTEGRATION_CONNECTED",
        aggregateType: "AyrshareProfile",
        aggregateId: profile.id,
        payload: {
          organisationId: profile.organisationId,
          providerKey: "AYRSHARE",
          connectionRef: profile.id,
        },
        dedupeKey,
      });
    });

    if (Array.isArray(payload.platforms) || payload.platform) {
      const networks = Array.isArray(payload.platforms)
        ? payload.platforms
        : payload.platform
          ? [payload.platform]
          : [];
      if (networks.length) {
        await prisma.ayrshareProfile.update({
          where: { id: profile.id },
          data: {
            connectedNetworks: networks,
            status: "CONNECTED",
            lastSyncAt: new Date(),
            lastError: null,
          },
        });
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    logger.error("Ayrshare webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
