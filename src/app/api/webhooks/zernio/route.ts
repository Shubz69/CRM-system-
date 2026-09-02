import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Prisma, WebhookProcessingStatus } from "@prisma/client";
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
  syncZernioConnectedAccountsWithRetry,
  verifyZernioWebhookSignature,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";
import {
  handleZernioCoverageEvent,
  ZERNIO_SUPPORTED_WEBHOOK_EVENTS,
} from "@/adapters/zernio/webhook-coverage";

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

async function markWebhook(
  eventId: string,
  data: { status: WebhookProcessingStatus; error?: string | null },
) {
  await prisma.webhookEvent.update({
    where: { provider_idempotencyKey: { provider: "ZERNIO", idempotencyKey: eventId } },
    data: {
      status: data.status,
      error: data.error ?? null,
      processedAt: new Date(),
    },
  });
}

/**
 * Zernio webhooks — fail-closed auth, tenant from stored Profile/account map,
 * Instagram message.received → canonical processInboundMessage,
 * lifecycle / engagement / publish events → webhook-coverage handlers.
 */
export async function POST(req: NextRequest) {
  let eventIdForTerminal: string | null = null;
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`zernio:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    if (!isZernioWebhookConfigured()) {
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
    eventIdForTerminal = eventId;

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
    if (
      existing &&
      (existing.status === WebhookProcessingStatus.PROCESSED ||
        existing.status === WebhookProcessingStatus.DUPLICATE ||
        existing.status === WebhookProcessingStatus.IGNORED)
    ) {
      return Response.json({ ok: true, duplicate: true });
    }

    if (!existing) {
      await prisma.webhookEvent.create({
        data: {
          organisationId,
          provider: "ZERNIO",
          eventType,
          idempotencyKey: eventId,
          payload: payload as Prisma.InputJsonValue,
          status: WebhookProcessingStatus.RECEIVED,
        },
      });
    } else {
      // RECEIVED / PROCESSING / FAILED — allow honest retry without leaving stuck RECEIVED
      await prisma.webhookEvent.update({
        where: { id: existing.id },
        data: {
          status: WebhookProcessingStatus.PROCESSING,
          error: null,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    }

    if (eventType === "message.received") {
      const normalized = normalizeZernioInboundMessage(payload);
      if (!normalized) {
        await markWebhook(eventId, {
          status: WebhookProcessingStatus.IGNORED,
          error: "unnormalizable_or_non_instagram_or_missing_sender",
        });
        return Response.json({ ok: true, ignored: true, reason: "unnormalizable_message" });
      }

      const raw = (normalized.raw || {}) as Record<string, unknown>;
      try {
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

        await markWebhook(eventId, {
          status: result.duplicate
            ? WebhookProcessingStatus.DUPLICATE
            : WebhookProcessingStatus.PROCESSED,
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
      } catch (inboundError) {
        const message =
          inboundError instanceof Error ? inboundError.message : "Inbound processing failed";
        await markWebhook(eventId, {
          status: WebhookProcessingStatus.FAILED,
          error: message.slice(0, 1000),
        });
        throw inboundError;
      }
    }

    if (eventType === "account.connected" || eventType === "account.disconnected") {
      const sync = await syncZernioConnectedAccountsWithRetry(organisationId, {
        attempts: eventType === "account.connected" ? 3 : 1,
        delayMs: 600,
        requireConnected: eventType === "account.connected",
      }).catch(async () => null);

      if (!sync?.ok) {
        const profile = await prisma.zernioProfile.findUnique({ where: { organisationId } });
        if (profile) {
          const accounts = Array.isArray(profile.connectedAccounts)
            ? ([...profile.connectedAccounts] as ZernioConnectedAccount[])
            : [];
          if (eventType === "account.connected" && accountId) {
            if (!accounts.some((a) => a.accountId === accountId)) {
              accounts.push({
                accountId,
                platform: String(payload.platform || account.platform || "unknown").toLowerCase(),
                status: "connected",
                username:
                  typeof account.username === "string" ? account.username.replace(/^@/, "") : undefined,
                displayName:
                  typeof account.displayName === "string" ? account.displayName : undefined,
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
            const { ensureZernioMessagingBindings } = await import("@/adapters/zernio");
            await prisma.zernioProfile.update({
              where: { organisationId },
              data: {
                connectedAccounts: next,
                status: next.some((a) => String(a.status || "connected").toLowerCase() !== "disconnected")
                  ? "CONNECTED"
                  : "DISCONNECTED",
                lastSyncAt: new Date(),
              },
            });
            await ensureZernioMessagingBindings(organisationId, next);
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        await appendDomainEvent(tx, {
          organisationId,
          eventType:
            eventType === "account.connected" ? "INTEGRATION_CONNECTED" : "INTEGRATION_DISCONNECTED",
          aggregateType: "ZernioProfile",
          aggregateId: organisationId,
          payload: {
            organisationId,
            providerKey: "ZERNIO",
            connectionRef: accountId || tenant.zernioProfileId,
          },
          dedupeKey: `zernio:${organisationId}:${eventId}`,
        });
      });

      await markWebhook(eventId, { status: WebhookProcessingStatus.PROCESSED });
      return Response.json({ ok: true, synced: Boolean(sync?.ok) });
    }

    const coverage = await handleZernioCoverageEvent({
      organisationId,
      zernioProfileId: tenant.zernioProfileId,
      eventType,
      eventId,
      payload,
      accountId,
    });

    if (coverage.handled) {
      await markWebhook(eventId, {
        status: coverage.ignored ? WebhookProcessingStatus.IGNORED : WebhookProcessingStatus.PROCESSED,
        error: coverage.reason || null,
      });
      return Response.json({
        ok: true,
        ignored: coverage.ignored === true,
        reason: coverage.reason,
        coverage: coverage.detail,
      });
    }

    // Unknown event type: ack safely with diagnostic provenance — no business guess.
    logger.info("Zernio webhook unknown event type acknowledged", {
      eventType,
      eventId: eventId.slice(0, 12),
      organisationId,
      supported: ZERNIO_SUPPORTED_WEBHOOK_EVENTS.length,
    });
    await markWebhook(eventId, {
      status: WebhookProcessingStatus.IGNORED,
      error: `unknown_event_type:${eventType}`,
    });
    return Response.json({
      ok: true,
      ignored: true,
      reason: "unknown_event_type",
      eventType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    logger.error("Zernio webhook failed", { message });
    if (eventIdForTerminal) {
      await markWebhook(eventIdForTerminal, {
        status: WebhookProcessingStatus.FAILED,
        error: message.slice(0, 1000),
      }).catch(() => undefined);
    }
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
