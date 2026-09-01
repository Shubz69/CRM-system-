import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  MetaInstagramNotConfiguredError,
  assertMetaInstagramMessagingConfigured,
} from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  disconnectMetaInstagram,
  getMetaInstagramConnectionView,
  isMetaInstagramAppConfigured,
  validateMetaInstagramConnection,
} from "@/services/messaging/meta-instagram";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";
import { dispatchOutboundMessage } from "@/services/messaging/outbound";

export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const connection = await getMetaInstagramConnectionView(session.organisationId);
    return Response.json({
      appConfigured: isMetaInstagramAppConfigured(),
      connection,
      reconnectHint:
        connection.health === "REAUTH_REQUIRED" || connection.health === "DISCONNECTED"
          ? "Reconnect with Instagram to restore messaging"
          : null,
      // Never return tokens.
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const actionSchema = z.object({
  action: z.enum(["disconnect", "validate_configuration", "send_test_message"]),
  text: z.string().optional(),
  contactId: z.string().optional(),
  conversationId: z.string().optional(),
  contactExternalId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = actionSchema.parse(await req.json());

    if (body.action === "disconnect") {
      await disconnectMetaInstagram({
        organisationId: session.organisationId,
        userId: session.userId,
      });
      return Response.json({
        ok: true,
        message: "Instagram (Meta) disconnected. Outbound is blocked. History is preserved.",
      });
    }

    if (body.action === "validate_configuration") {
      try {
        assertMetaInstagramMessagingConfigured();
      } catch (error) {
        if (error instanceof MetaInstagramNotConfiguredError) {
          return Response.json({
            ok: false,
            sent: false,
            status: "Not configured",
            detail: error.message,
            health: "NOT_CONFIGURED",
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }
      const result = await validateMetaInstagramConnection(session.organisationId);
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.meta_instagram.validate_configuration",
        entityType: "Integration",
        entityId: "meta_instagram",
        metadata: { ok: result.ok, health: result.health, status: result.status },
      });
      return Response.json({
        ok: result.ok,
        sent: false,
        status: result.status,
        detail: result.detail,
        health: result.health,
        message: result.detail,
      });
    }

    if (body.action === "send_test_message") {
      try {
        assertMetaInstagramMessagingConfigured();
      } catch (error) {
        if (error instanceof MetaInstagramNotConfiguredError) {
          return jsonError(error.message, 503);
        }
        throw error;
      }
      const view = await getMetaInstagramConnectionView(session.organisationId);
      if (!view.isActive || view.health === "DISCONNECTED" || view.health === "NOT_CONFIGURED") {
        return jsonError("Instagram is not connected — reconnect before sending a test message", 400);
      }

      const conversationId = body.conversationId?.trim();
      const contactId = body.contactId?.trim();
      if (!conversationId || !contactId) {
        return jsonError(
          "contactId and conversationId are required — test sends only to an existing conversation with prior inbound",
          400,
        );
      }

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          organisationId: session.organisationId,
          contactId,
          deletedAt: null,
        },
        include: {
          contact: {
            include: {
              identifiers: {
                where: { channel: MESSAGING_PROVIDER.META_INSTAGRAM },
                take: 1,
              },
            },
          },
        },
      });
      if (!conversation) {
        return jsonError("Conversation not found for this workspace", 404);
      }

      const identifier = conversation.contact.identifiers[0];
      const contactExternalId =
        body.contactExternalId?.trim() ||
        (identifier
          ? identifier.identifier.replace(/^meta_instagram:/, "")
          : null);
      if (!contactExternalId) {
        return jsonError(
          "No Meta Instagram contact identifier on this conversation — wait for an inbound DM first",
          404,
        );
      }

      const text = body.text?.trim() || "Test message from Agent Desk Integrations";
      const result = await dispatchOutboundMessage({
        organisationId: session.organisationId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        contactExternalId,
        content: text,
        source: "HUMAN",
        actorId: session.userId,
        provider: MESSAGING_PROVIDER.META_INSTAGRAM,
        channel: MESSAGING_PROVIDER.META_INSTAGRAM,
        idempotencyKey: `meta_instagram_test:${session.organisationId}:${conversation.id}:${Date.now()}`,
        metadata: { origin: "integrations_send_test_message" },
      });

      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "integration.meta_instagram.send_test_message",
        entityType: "Integration",
        entityId: "meta_instagram",
        metadata: {
          ok: result.ok,
          code: result.code,
          conversationId: conversation.id,
          contactId: conversation.contactId,
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

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
