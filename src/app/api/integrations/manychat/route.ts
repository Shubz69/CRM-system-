import { NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  getOrganisationManyChatSecret,
  maskSecret,
  regenerateOrganisationManyChatSecret,
} from "@/services/manychat-secrets";
import { getMessagingAdapterForOrganisation } from "@/adapters/messaging";
import { processInboundMessage } from "@/services/inbound-pipeline";
import {
  getOrganisationManyChatApiToken,
} from "@/services/messaging/credentials";

export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const env = getEnv();
    const appUrl = env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000";

    const channels = await prisma.messagingChannel.findMany({
      where: { organisationId: session.organisationId, provider: "manychat" },
      orderBy: { createdAt: "asc" },
    });

    const orgSecret = await getOrganisationManyChatSecret(session.organisationId);
    const secretConfigured = Boolean(orgSecret || env.MANYCHAT_WEBHOOK_SECRET);
    const orgApiToken = await getOrganisationManyChatApiToken(session.organisationId);
    const apiTokenConfigured = Boolean(orgApiToken || env.MANYCHAT_API_TOKEN);
    const connected = channels.some((c) => c.isActive) && secretConfigured;

    const recentEvents = await prisma.webhookEvent.findMany({
      where: { organisationId: session.organisationId, provider: "manychat" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        eventType: true,
        status: true,
        error: true,
        createdAt: true,
        processedAt: true,
      },
    });

    const lastInbound = recentEvents[0] ?? null;
    const recentErrors = recentEvents.filter((e) => e.status === "FAILED" || e.error);

    return Response.json({
      webhookUrl: `${appUrl.replace(/\/$/, "")}/api/webhooks/manychat`,
      inboundAliasUrl: `${appUrl.replace(/\/$/, "")}/api/integrations/manychat/inbound`,
      secretConfigured,
      secretMasked: maskSecret(orgSecret || env.MANYCHAT_WEBHOOK_SECRET),
      secretSource: orgSecret ? "organisation" : "environment",
      apiTokenConfigured,
      apiTokenMasked: apiTokenConfigured ? "•••• configured" : "not set",
      apiTokenSource: orgApiToken ? "organisation" : env.MANYCHAT_API_TOKEN ? "environment" : "none",
      channels,
      connected,
      lastInboundEvent: lastInbound
        ? {
            id: lastInbound.id,
            eventType: lastInbound.eventType,
            status: lastInbound.status,
            receivedAt: lastInbound.createdAt,
          }
        : null,
      recentErrors: recentErrors.map((e) => ({
        id: e.id,
        error: e.error,
        status: e.status,
        receivedAt: e.createdAt,
      })),
      setup: {
        requiredHeaders: ["x-manychat-secret"],
        requiredFields: ["subscriber_id", "text|message"],
        optionalFields: [
          "organisationId",
          "channel_id",
          "id",
          "ig_username",
          "first_name",
          "last_name",
          "email",
          "phone",
          "thread_id",
          "campaign",
        ],
        examplePayload: {
          organisationId: session.organisationId,
          subscriber_id: "123456",
          ig_username: "prospect",
          first_name: "Alex",
          text: "Hi, how much does this cost?",
          campaign: "spring_promo",
          id: "evt_example_001",
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const actionSchema = z.object({
  action: z.enum(["regenerate_secret", "test_inbound", "test_outbound"]),
  text: z.string().optional(),
  contactExternalId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = actionSchema.parse(await req.json());

    if (body.action === "regenerate_secret") {
      const secret = await regenerateOrganisationManyChatSecret(session.organisationId);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.secret_regenerated",
        entityType: "Integration",
        entityId: "manychat",
      });
      // Return full secret once only after regeneration.
      return Response.json({
        ok: true,
        secret,
        secretMasked: maskSecret(secret),
        message: "Copy this secret now — it will not be shown again in full.",
      });
    }

    if (body.action === "test_inbound") {
      const result = await processInboundMessage(
        {
          organisationId: session.organisationId,
          contact: {
            externalId: body.contactExternalId || `test_${Date.now()}`,
            fullName: "ManyChat Test Contact",
            instagramUsername: "manychat_test",
          },
          message: {
            text: body.text || "Test inbound webhook from Integrations page",
            externalId: `test_in_${Date.now()}`,
          },
          leadSource: "manychat_test",
          campaignSource: "integration_test",
        },
        { provider: "manychat_test", rawPayload: { source: "integrations_ui" } },
      );
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.test_inbound",
        entityType: "Integration",
        entityId: "manychat",
        metadata: { duplicate: result.duplicate, conversationId: result.conversationId },
      });
      return Response.json({ ok: true, result });
    }

    // Administrative integration probe — not a conversation message.
    // Uses org credential resolver; does not create OutboundDispatch (no conversation).
    const adapter = await getMessagingAdapterForOrganisation(session.organisationId);
    const send = await adapter.sendMessage({
      organisationId: session.organisationId,
      contactExternalId: body.contactExternalId || "test_contact",
      text: body.text || "Test outbound message from Agent Desk",
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "integration.test_outbound",
      entityType: "Integration",
      entityId: "manychat",
      metadata: { ok: send.ok },
    });
    return Response.json({ ok: send.ok, send });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
