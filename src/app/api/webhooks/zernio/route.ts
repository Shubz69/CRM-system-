import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import {
  findOrganisationIdByZernioAccountId,
  findOrganisationIdByZernioProfileId,
  syncZernioConnectedAccounts,
  verifyZernioWebhookSignature,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";

/**
 * Zernio webhooks — HMAC signature, profile/account → organisation mapping.
 * Idempotent via WebhookEvent unique (provider, idempotencyKey).
 * No new BullMQ worker; DomainEvent outbox for durable fan-out.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`zernio:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    if (!env.ZERNIO_WEBHOOK_SECRET?.trim()) {
      return Response.json(
        { ok: false, code: "ZERNIO_NOT_CONFIGURED", error: "Zernio webhook secret not configured" },
        { status: 503 },
      );
    }

    const rawBody = await req.text();
    const signature =
      req.headers.get("x-zernio-signature") || req.headers.get("x-late-signature") || null;
    if (!verifyZernioWebhookSignature(rawBody, signature)) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const eventId =
      (typeof payload.id === "string" && payload.id) ||
      req.headers.get("x-zernio-event-id") ||
      req.headers.get("x-late-event-id") ||
      createHash("sha256").update(rawBody).digest("hex");

    const eventType = String(payload.event || payload.type || "zernio.event");
    if (eventType === "webhook.test") {
      return Response.json({ ok: true, test: true });
    }

    const profileId =
      (typeof payload.profileId === "string" && payload.profileId) ||
      (payload.profile && typeof (payload.profile as { id?: string }).id === "string"
        ? (payload.profile as { id: string }).id
        : null);

    const accountId =
      (typeof payload.accountId === "string" && payload.accountId) ||
      (payload.account && typeof (payload.account as { id?: string }).id === "string"
        ? (payload.account as { id: string }).id
        : null);

    let organisationId: string | null = null;
    if (profileId) {
      organisationId = await findOrganisationIdByZernioProfileId(profileId);
    }
    if (!organisationId && accountId) {
      const hit = await findOrganisationIdByZernioAccountId(accountId);
      organisationId = hit?.organisationId ?? null;
    }

    if (!organisationId) {
      logger.warn("Zernio webhook unresolved tenant", {
        eventType,
        eventId: eventId.slice(0, 12),
      });
      return Response.json({ ok: true, ignored: true, reason: "unknown_tenant" });
    }

    const existing = await prisma.webhookEvent.findUnique({
      where: {
        provider_idempotencyKey: {
          provider: "ZERNIO",
          idempotencyKey: eventId,
        },
      },
    });
    if (existing) {
      return Response.json({ ok: true, duplicate: true });
    }

    await prisma.webhookEvent.create({
      data: {
        organisationId,
        provider: "ZERNIO",
        eventType,
        idempotencyKey: eventId,
        payload: payload as Prisma.InputJsonValue,
        status: "RECEIVED",
      },
    });

    if (eventType === "account.connected" || eventType === "account.disconnected") {
      await syncZernioConnectedAccounts(organisationId).catch(async () => {
        // Soft fallback: mutate from webhook payload when sync API unavailable
        const profile = await prisma.zernioProfile.findUnique({ where: { organisationId } });
        if (!profile) return;
        const accounts = Array.isArray(profile.connectedAccounts)
          ? ([...profile.connectedAccounts] as ZernioConnectedAccount[])
          : [];
        if (eventType === "account.connected" && accountId) {
          if (!accounts.some((a) => a.accountId === accountId)) {
            accounts.push({
              accountId,
              platform: String(payload.platform || "unknown"),
              status: "connected",
            });
          }
          await prisma.zernioProfile.update({
            where: { organisationId },
            data: {
              connectedAccounts: accounts,
              status: "CONNECTED",
              lastSyncAt: new Date(),
              lastError: null,
            },
          });
        }
        if (eventType === "account.disconnected" && accountId) {
          const next = accounts.filter((a) => a.accountId !== accountId);
          await prisma.zernioProfile.update({
            where: { organisationId },
            data: {
              connectedAccounts: next,
              status: next.length ? "CONNECTED" : "DISCONNECTED",
              lastSyncAt: new Date(),
            },
          });
        }
      });
    }

    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId,
        eventType: "INTEGRATION_CONNECTED",
        aggregateType: "ZernioProfile",
        aggregateId: organisationId,
        payload: {
          organisationId,
          providerKey: "ZERNIO",
          zernioEvent: eventType,
          accountId,
          profileId,
        },
        dedupeKey: `zernio:${organisationId}:${eventId}`,
      });
    });

    await prisma.webhookEvent.update({
      where: {
        provider_idempotencyKey: { provider: "ZERNIO", idempotencyKey: eventId },
      },
      data: { status: "PROCESSED", processedAt: new Date() },
    });

    return Response.json({ ok: true });
  } catch (error) {
    logger.error("Zernio webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
