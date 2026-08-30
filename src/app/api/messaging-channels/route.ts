import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

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
  provider: z.string().default("manychat"),
  externalId: z.string().min(1),
  displayName: z.string().min(1),
  instagramUsername: z.string().optional(),
  isActive: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = upsertSchema.parse(await req.json());

    if (body.id) {
      const existing = await prisma.messagingChannel.findFirst({
        where: { id: body.id, organisationId: session.organisationId },
      });
      if (!existing) return jsonError("Channel not found", 404);
      const channel = await prisma.messagingChannel.update({
        where: { id: existing.id },
        data: {
          externalId: body.externalId,
          displayName: body.displayName,
          instagramUsername: body.instagramUsername,
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
        instagramUsername: body.instagramUsername,
        isActive: body.isActive ?? true,
      },
      create: {
        organisationId: session.organisationId,
        provider: body.provider,
        externalId: body.externalId,
        displayName: body.displayName,
        instagramUsername: body.instagramUsername,
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
