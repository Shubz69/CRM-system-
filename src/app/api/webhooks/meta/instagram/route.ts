import { NextRequest } from "next/server";
import { normalizeAllMetaInstagramWebhookMessages } from "@/adapters/messaging/meta-instagram";
import { assertProductionSecretsConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { processInboundMessage } from "@/services/inbound-pipeline";
import {
  hashMetaPayload,
  resolveOrganisationByMetaIgAccountId,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
} from "@/services/messaging/meta-instagram";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";
import { recordUsage } from "@/services/usage";

/** GET — Meta webhook verification challenge. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl ?? new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verified = verifyMetaWebhookChallenge({ mode, token, challenge });
  if (!verified) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(verified, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/** POST — Instagram messaging webhooks. Ack quickly; fail closed on unknown accounts. */
export async function POST(req: NextRequest) {
  try {
    assertProductionSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`meta-instagram:${ip}`, 180, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get("x-hub-signature-256");
    if (!verifyMetaWebhookSignature({ rawBody, signatureHeader })) {
      logger.warn("Meta Instagram webhook signature rejected", {
        hasSignature: Boolean(signatureHeader),
        payloadHash: hashMetaPayload(rawBody).slice(0, 12),
      });
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const messages = normalizeAllMetaInstagramWebhookMessages(payload);
    if (messages.length === 0) {
      return Response.json({ ok: true, ignored: true, reason: "no_actionable_messages" });
    }

    const results: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      const recipientId =
        msg.raw && typeof msg.raw === "object" && "recipientId" in msg.raw
          ? String((msg.raw as { recipientId?: string }).recipientId || "")
          : "";
      if (!recipientId) {
        results.push({ ignored: true, reason: "missing_recipient" });
        continue;
      }

      const resolved = await resolveOrganisationByMetaIgAccountId(recipientId);
      if (!resolved) {
        // Fail closed attribution — do not invent org; still ack so Meta does not retry forever.
        logger.warn("Meta Instagram webhook ignored — unknown IG account", {
          recipientHash: hashMetaPayload(recipientId).slice(0, 12),
        });
        results.push({
          ignored: true,
          reason: "unknown_instagram_account",
        });
        continue;
      }

      try {
        const result = await processInboundMessage(
          {
            organisationId: resolved.organisationId,
            channelExternalId: recipientId,
            idempotencyKey: msg.externalMessageId,
            contact: {
              externalId: msg.contactExternalId,
              fullName: undefined,
              instagramUsername: undefined,
            },
            message: {
              text: msg.text,
              externalId: msg.externalMessageId,
            },
            threadId: msg.threadId,
            leadSource: "instagram_meta",
          },
          { provider: MESSAGING_PROVIDER.META_INSTAGRAM, rawPayload: msg.raw ?? payload },
        );

        await recordUsage({
          organisationId: resolved.organisationId,
          feature: "webhook_inbound",
          provider: MESSAGING_PROVIDER.META_INSTAGRAM,
          metadata: { duplicate: result.duplicate },
        });

        results.push({
          ok: true,
          duplicate: result.duplicate,
          conversationId: result.conversationId,
        });
      } catch (error) {
        logger.error("Meta Instagram inbound processing failed", {
          message: error instanceof Error ? error.message : "unknown",
          organisationId: resolved.organisationId,
        });
        results.push({ ok: false, error: "processing_failed" });
      }
    }

    return Response.json({ ok: true, results });
  } catch (error) {
    logger.error("Meta Instagram webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
