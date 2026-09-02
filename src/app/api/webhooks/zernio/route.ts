import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { normalizeZernioInboundMessage } from "@/adapters/messaging/zernio";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";
import {
  assertZernioWebhookConfigured,
  isZernioWebhookConfigured,
  resolveZernioWebhookTenant,
  syncZernioConnectedAccounts,
  verifyZernioWebhookSignature,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Zernio webhooks — fail-closed auth, tenant from stored Profile/account map,
 * Instagram message.received → canonical processInboundMessage.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`zernio:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    if (!isZernioWebhookConfigured()) {
      // Provider-scoped NOT_CONFIGURED — does not affect CRM / other webhooks / worker.
      return Response.json(
        {
          ok: false,
          code: "ZERNIO_NOT_CONFIGURED",
          error: "Zernio webhook secret not configured",
        },
        { status: 503 },
      );
    }
    assertZernioWebhookConfigured();

    const rawBody = await req.text();
    const signature =
      req.headers.get("x-zernio-signature") || req.headers.get("x-late-signature") || null;
    if (!signature) {
      return Response.json({ error: "Missing signature", code: "SIGNATURE_MISSING" }, { status: 401 });
    }
    if (!verifyZernioWebhookSignature(rawBody, signature)) {
      return Response.json({ error: "Invalid signature", code: "SIGNATURE_INVALID" }, { status: 401 });
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

    const account = (payload.account && typeof payload.account === "object"
      ? (payload.account as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const profileId =
      pickString(payload.profileId, account.profileId) ||
      (payload.profile && typeof (payload.profile as { id?: string }).id === "string"
        ? (payload.profile as { id: string }).id
        : null);
    const accountId =
      pickString(payload.accountId, account.id, account.accountId) || null;

    const tenant = await resolveZernioWebhookTenant({ profileId, accountId });
    if (!tenant.ok) {
      logger.warn("Zernio webhook tenant rejected", {
        eventType,
        eventId: eventId.slice(0, 12),
        code: tenant.code,
      });
      // Quarantine without inventing an organisation
      return Response.json(
        { ok: false, ignored: true, reason: tenant.code },
        { status: tenant.code === "UNKNOWN_PROFILE" || tenant.code === "UNKNOWN_ACCOUNT" ? 404 : 400 },
      );
    }

    const organisationId = tenant.organisationId;

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

    if (eventType === "message.received") {
      const normalized = normalizeZernioInboundMessage(payload);
      if (!normalized) {
        await prisma.webhookEvent.update({
          where: { provider_idempotencyKey: { provider: "ZERNIO", idempotencyKey: eventId } },
          data: {
            status: "IGNORED",
            error: "unnormalizable_or_non_instagram_or_missing_sender",
            processedAt: new Date(),
          },
        });
        return Response.json({ ok: true, ignored: true, reason: "unnormalizable_message" });
      }

      const raw = (normalized.raw || {}) as Record<string, unknown>;
      const result = await processInboundMessage(
        {
          organisationId,
          channelExternalId: typeof raw.accountId === "string" ? raw.accountId : accountId || undefined,
          idempotencyKey: normalized.externalMessageId || eventId,
          contact: {
            externalId: normalized.contactExternalId,
            fullName: typeof raw.displayName === "string" ? raw.displayName : undefined,
            instagramUsername: typeof raw.username === "string" ? raw.username : undefined,
          },
          message: {
            text: normalized.text,
            externalId: normalized.externalMessageId,
            sentAt: normalized.sentAt,
          },
          threadId: normalized.threadId,
          leadSource: "instagram_zernio",
          metadata: {
            zernio: {
              conversationId: raw.zernioConversationId,
              accountId: raw.accountId,
              profileId: tenant.zernioProfileId,
              provider: "ZERNIO",
              network: "INSTAGRAM",
            },
          },
        },
        { provider: MESSAGING_PROVIDER.ZERNIO, rawPayload: payload },
      );

      await prisma.webhookEvent.update({
        where: { provider_idempotencyKey: { provider: "ZERNIO", idempotencyKey: eventId } },
        data: {
          status: result.duplicate ? "DUPLICATE" : "PROCESSED",
          processedAt: new Date(),
        },
      });

      return Response.json({
        ok: true,
        inbound: {
          duplicate: result.duplicate,
          contactId: result.contactId,
          conversationId: result.conversationId,
          messageId: result.messageId,
        },
      });
    }

    if (eventType === "account.connected" || eventType === "account.disconnected") {
      await syncZernioConnectedAccounts(organisationId).catch(async () => {
        const profile = await prisma.zernioProfile.findUnique({ where: { organisationId } });
        if (!profile) return;
        const accounts = Array.isArray(profile.connectedAccounts)
          ? ([...profile.connectedAccounts] as ZernioConnectedAccount[])
          : [];
        if (eventType === "account.connected" && accountId) {
          if (!accounts.some((a) => a.accountId === accountId)) {
            accounts.push({
              accountId,
              platform: String(payload.platform || account.platform || "unknown"),
              status: "connected",
            });
          }
          const { ensureZernioMessagingBindings } = await import("@/adapters/zernio");
          await prisma.zernioProfile.update({
            where: { organisationId },
            data: {
              connectedAccounts: accounts,
              status: "CONNECTED",
              lastSyncAt: new Date(),
              lastError: null,
            },
          });
          await ensureZernioMessagingBindings(organisationId, accounts);
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
          profileId: tenant.zernioProfileId,
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
