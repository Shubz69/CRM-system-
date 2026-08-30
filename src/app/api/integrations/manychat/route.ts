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
import { processInboundMessage } from "@/services/inbound-pipeline";
import {
  disconnectOrganisationManyChat,
  getOrganisationManyChatApiToken,
  getOrganisationManyChatConnectionState,
  reconnectOrganisationManyChat,
  setOrganisationManyChatApiToken,
} from "@/services/messaging/credentials";
import { dispatchOutboundMessage } from "@/services/messaging/outbound";

function apiTokenStatusLabel(configured: boolean): "Configured" | "Not configured" {
  return configured ? "Configured" : "Not configured";
}

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
    const connection = await getOrganisationManyChatConnectionState(session.organisationId);
    const activeOrgToken = await getOrganisationManyChatApiToken(session.organisationId);
    const envToken = Boolean(env.MANYCHAT_API_TOKEN?.trim());
    // Status for operators: org stored token, or env when no revoked org connection blocks it.
    const apiTokenConfigured = connection.hasStoredApiToken
      ? true
      : connection.exists && !connection.isActive
        ? false
        : envToken || Boolean(activeOrgToken);
    const connected =
      connection.isActive &&
      channels.some((c) => c.isActive) &&
      secretConfigured &&
      apiTokenConfigured;

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
      apiTokenStatus: apiTokenStatusLabel(apiTokenConfigured),
      // Never return plaintext — masked status only.
      apiTokenMasked: apiTokenConfigured ? "•••• configured" : "not set",
      apiTokenSource: connection.hasStoredApiToken
        ? "organisation"
        : envToken && !(connection.exists && !connection.isActive)
          ? "environment"
          : "none",
      connectionActive: connection.isActive,
      connectionRef: connection.connectionRef,
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
  action: z.enum([
    "regenerate_secret",
    "save_api_token",
    "disconnect",
    "reconnect",
    "validate_configuration",
    "send_test_message",
    "test_inbound",
  ]),
  apiToken: z.string().optional(),
  text: z.string().optional(),
  contactExternalId: z.string().optional(),
  conversationId: z.string().optional(),
});

async function validateManyChatConfiguration(organisationId: string): Promise<{
  ok: boolean;
  checks: Record<string, boolean | string>;
  message: string;
}> {
  const env = getEnv();
  const connection = await getOrganisationManyChatConnectionState(organisationId);
  const orgSecret = await getOrganisationManyChatSecret(organisationId);
  const secretConfigured = Boolean(orgSecret || env.MANYCHAT_WEBHOOK_SECRET);
  const token = await getOrganisationManyChatApiToken(organisationId);
  const envToken = env.MANYCHAT_API_TOKEN?.trim() || null;
  const effectiveToken = token || (connection.isActive || !connection.exists ? envToken : null);

  const channels = await prisma.messagingChannel.findMany({
    where: { organisationId, provider: "manychat", isActive: true },
    select: { id: true },
  });

  const checks: Record<string, boolean | string> = {
    connectionActive: connection.isActive || (!connection.exists && Boolean(effectiveToken)),
    apiTokenConfigured: Boolean(effectiveToken),
    webhookSecretConfigured: secretConfigured,
    activeChannelMapped: channels.length > 0,
  };

  const missing: string[] = [];
  if (!checks.apiTokenConfigured) missing.push("API token");
  if (!checks.webhookSecretConfigured) missing.push("webhook secret");
  if (!checks.activeChannelMapped) missing.push("active messaging channel");
  if (connection.exists && !connection.isActive) missing.push("connection is disconnected");

  if (missing.length) {
    return {
      ok: false,
      checks,
      message: `Configuration incomplete: ${missing.join(", ")}. No message was sent.`,
    };
  }

  // Optional live probe — getInfo only, never sendContent / never dispatchOutboundMessage.
  try {
    const base = env.MANYCHAT_API_BASE_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/fb/page/getInfo`, {
      headers: {
        Authorization: `Bearer ${effectiveToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      checks.apiProbe = false;
      return {
        ok: false,
        checks,
        message: `ManyChat rejected the API token (${response.status}). No message was sent. ${body.slice(0, 120)}`,
      };
    }
    checks.apiProbe = true;
  } catch (error) {
    checks.apiProbe = false;
    return {
      ok: false,
      checks,
      message: `Could not reach ManyChat to validate the token. No message was sent. ${
        error instanceof Error ? error.message : ""
      }`.trim(),
    };
  }

  return {
    ok: true,
    checks,
    message: "Configuration looks valid. No message was sent.",
  };
}

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

    if (body.action === "save_api_token") {
      const token = body.apiToken?.trim();
      if (!token) return jsonError("API token is required", 400);
      const result = await setOrganisationManyChatApiToken(session.organisationId, token);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: result.rotated ? "integration.api_token_rotated" : "integration.api_token_saved",
        entityType: "Integration",
        entityId: "manychat",
        metadata: { rotated: result.rotated, connectionRef: result.connectionRef },
      });
      // Never return plaintext token.
      return Response.json({
        ok: true,
        rotated: result.rotated,
        apiTokenConfigured: true,
        apiTokenStatus: result.apiTokenStatus,
        apiTokenMasked: "•••• configured",
        message: result.rotated
          ? "API token rotated. Previous credential superseded."
          : "API token saved.",
      });
    }

    if (body.action === "disconnect") {
      const result = await disconnectOrganisationManyChat(session.organisationId);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.disconnected",
        entityType: "Integration",
        entityId: "manychat",
        metadata: { connectionRef: result.connectionRef },
      });
      return Response.json({
        ok: true,
        connectionActive: false,
        message: "ManyChat disconnected. Outbound sends are blocked. Conversation history is preserved.",
      });
    }

    if (body.action === "reconnect") {
      const result = await reconnectOrganisationManyChat(session.organisationId);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.reconnected",
        entityType: "Integration",
        entityId: "manychat",
        metadata: { connectionRef: result.connectionRef },
      });
      return Response.json({
        ok: true,
        connectionActive: true,
        message: "ManyChat reconnected.",
      });
    }

    if (body.action === "validate_configuration") {
      const result = await validateManyChatConfiguration(session.organisationId);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.validate_configuration",
        entityType: "Integration",
        entityId: "manychat",
        metadata: { ok: result.ok, checks: result.checks },
      });
      return Response.json({
        ok: result.ok,
        sent: false,
        checks: result.checks,
        message: result.message,
      });
    }

    if (body.action === "send_test_message") {
      const contactExternalId = body.contactExternalId?.trim();
      if (!contactExternalId) {
        return jsonError(
          "contactExternalId is required — send a test DM only to a real ManyChat subscriber",
          400,
        );
      }

      const connection = await getOrganisationManyChatConnectionState(session.organisationId);
      if (connection.exists && !connection.isActive) {
        return jsonError("ManyChat is disconnected — reconnect before sending a test message", 400);
      }

      const identifier = `manychat:${contactExternalId}`;
      const contactIdentifier = await prisma.contactIdentifier.findFirst({
        where: {
          organisationId: session.organisationId,
          channel: "manychat",
          identifier,
        },
        include: {
          contact: {
            include: {
              conversations: {
                where: { organisationId: session.organisationId, deletedAt: null },
                orderBy: { lastMessageAt: "desc" },
                take: 1,
              },
            },
          },
        },
      });

      if (!contactIdentifier) {
        return jsonError(
          "No contact found for that ManyChat subscriber in this workspace. Use a real contact who has already messaged you.",
          404,
        );
      }

      const conversation =
        (body.conversationId
          ? await prisma.conversation.findFirst({
              where: {
                id: body.conversationId,
                organisationId: session.organisationId,
                contactId: contactIdentifier.contactId,
                deletedAt: null,
              },
            })
          : null) ?? contactIdentifier.contact.conversations[0];

      if (!conversation) {
        return jsonError(
          "That contact has no conversation in this workspace yet. Wait for an inbound DM first.",
          404,
        );
      }

      const text = body.text?.trim() || "Test message from Agent Desk Integrations";
      const result = await dispatchOutboundMessage({
        organisationId: session.organisationId,
        conversationId: conversation.id,
        contactId: contactIdentifier.contactId,
        contactExternalId,
        content: text,
        source: "HUMAN",
        actorId: session.userId,
        idempotencyKey: `manychat_test:${session.organisationId}:${conversation.id}:${Date.now()}`,
        metadata: { origin: "integrations_send_test_message" },
      });

      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.send_test_message",
        entityType: "Integration",
        entityId: "manychat",
        metadata: {
          ok: result.ok,
          code: result.code,
          conversationId: conversation.id,
          contactId: contactIdentifier.contactId,
        },
      });

      return Response.json({
        ok: result.ok,
        sent: result.ok,
        result,
        message: result.ok
          ? "Test message dispatched via the live outbound path."
          : `Test message not sent (${result.code}).`,
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

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
