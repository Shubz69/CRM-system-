import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { persistableChannelInstagramUsername } from "@/services/messaging/channel-identity";

export async function GET() {
  try {
    const session = await requirePermission("settings:read");
    const channels = await prisma.messagingChannel.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "asc" },
    });
    return Response.json({ channels });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const upsertSchema = z.object({
  id: z.string().optional(),
  // Only ManyChat channels are registered by hand. Meta Instagram / Zernio channels are
  // created by their own verified connect flows; accepting any provider here let one
  // workspace register another workspace's Instagram account id and divert its DMs.
  provider: z.literal("manychat").default("manychat"),
  externalId: z.string().trim().min(1),
  displayName: z.string().min(1),
  instagramUsername: z.string().optional(),
  isActive: z.boolean().optional(),
});

/** Another workspace already receives webhooks for this provider + external id. */
async function claimedByAnotherWorkspace(
  organisationId: string,
  provider: string,
  externalId: string,
): Promise<boolean> {
  const other = await prisma.messagingChannel.findFirst({
    where: { provider, externalId, isActive: true, organisationId: { not: organisationId } },
    select: { id: true, organisationId: true },
  });
  return Boolean(other && other.organisationId !== organisationId);
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = upsertSchema.parse(await req.json());
    const instagramUsername =
      body.instagramUsername !== undefined
        ? persistableChannelInstagramUsername(body.instagramUsername)
        : undefined;

    if (await claimedByAnotherWorkspace(session.organisationId, body.provider, body.externalId)) {
      return jsonError(
        "This channel ID is already connected to another workspace. Check the ID in ManyChat, or contact support if you own it.",
        409,
      );
    }

    if (body.id) {
      const existing = await prisma.messagingChannel.findFirst({
        where: { id: body.id, organisationId: session.organisationId },
      });
      if (!existing) return jsonError("Channel not found", 404);
      if (existing.provider !== body.provider) {
        return jsonError("Only ManyChat channels can be edited here.", 400);
      }
      const channel = await prisma.messagingChannel.update({
        where: { id: existing.id },
        data: {
          externalId: body.externalId,
          displayName: body.displayName,
          instagramUsername,
          isActive: body.isActive ?? existing.isActive,
          provider: body.provider,
        },
      });
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "messaging_channel.updated",
        entityType: "MessagingChannel",
        entityId: channel.id,
        metadata: {
          provider: channel.provider,
          externalId: channel.externalId,
          isActive: channel.isActive,
        },
      });
      return Response.json({ channel });
    }

    const existingByKey = await prisma.messagingChannel.findUnique({
      where: {
        organisationId_provider_externalId: {
          organisationId: session.organisationId,
          provider: body.provider,
          externalId: body.externalId,
        },
      },
    });

    const channel = await prisma.messagingChannel.upsert({
      where: {
        organisationId_provider_externalId: {
          organisationId: session.organisationId,
          provider: body.provider,
          externalId: body.externalId,
        },
      },
      update: {
        displayName: body.displayName,
        instagramUsername,
        isActive: body.isActive ?? true,
      },
      create: {
        organisationId: session.organisationId,
        provider: body.provider,
        externalId: body.externalId,
        displayName: body.displayName,
        instagramUsername: instagramUsername ?? null,
        isActive: body.isActive ?? true,
      },
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: existingByKey ? "messaging_channel.updated" : "messaging_channel.created",
      entityType: "MessagingChannel",
      entityId: channel.id,
      metadata: {
        provider: channel.provider,
        externalId: channel.externalId,
        isActive: channel.isActive,
      },
    });

    return Response.json({ channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
