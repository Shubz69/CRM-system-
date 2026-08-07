import { NextRequest } from "next/server";
import { z } from "zod";
import { MemberRole, OrganisationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

const createSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  timezone: z.string().optional(),
  ownerEmail: z.string().email().optional(),
});

const mutateSchema = z.object({
  action: z.enum(["suspend", "reactivate", "update"]),
  organisationId: z.string().min(1),
  name: z.string().min(2).max(120).optional(),
  timezone: z.string().optional(),
  plan: z.string().optional(),
});

export async function GET() {
  try {
    await requirePlatformAccess();
    const orgs = await prisma.organisation.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        members: {
          where: { role: { in: [MemberRole.OWNER, MemberRole.SUPER_ADMIN] } },
          include: { user: { select: { id: true, email: true, name: true } } },
          take: 3,
        },
        integrations: { select: { type: true, isActive: true } },
        agentConfigurations: {
          where: { isActive: true },
          select: { id: true, aiProvider: true },
          take: 1,
        },
        _count: {
          select: {
            members: true,
            contacts: true,
            conversations: true,
            leads: true,
          },
        },
      },
    });

    return Response.json({
      workspaces: orgs.map((org) => {
        const owner = org.members[0]?.user;
        const manychat = org.integrations.find((i) => i.type === "MANYCHAT");
        const booking = org.integrations.find((i) => i.type === "BOOKING");
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          status: org.status,
          autopilotMode: org.autopilotMode,
          demoData: org.demoData,
          timezone: org.timezone,
          createdAt: org.createdAt.toISOString(),
          lastActivityAt: org.lastActivityAt?.toISOString() ?? null,
          owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
          users: org._count.members,
          contacts: org._count.contacts,
          conversations: org._count.conversations,
          leads: org._count.leads,
          aiStatus: org.agentConfigurations[0] ? "Configured" : "Not configured",
          manychatStatus: manychat?.isActive ? "Connected" : "Not connected",
          bookingStatus: booking?.isActive ? "Connected" : "Not connected",
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = z.union([createSchema, mutateSchema]).parse(await req.json());

    if (body.action === "create") {
      const existing = await prisma.organisation.findUnique({ where: { slug: body.slug } });
      if (existing) return jsonError("Slug already in use", 409);

      const org = await prisma.organisation.create({
        data: {
          name: body.name,
          slug: body.slug,
          timezone: body.timezone || "UTC",
          status: OrganisationStatus.ACTIVE,
          autopilotMode: "OFF",
          pipelines: {
            create: {
              name: "Default",
              isDefault: true,
              stages: {
                create: [
                  { name: "New", slug: "new", position: 0 },
                  { name: "Contacted", slug: "contacted", position: 1 },
                  { name: "Engaged", slug: "engaged", position: 2 },
                  { name: "Qualifying", slug: "qualifying", position: 3 },
                  { name: "Qualified", slug: "qualified", position: 4 },
                  { name: "Booking Link Sent", slug: "booking_offered", position: 5 },
                  { name: "Booked", slug: "booked", position: 6 },
                  { name: "Won", slug: "won", position: 7, isWon: true },
                  { name: "Disqualified", slug: "disqualified", position: 8, isLost: true },
                ],
              },
            },
          },
          agentConfigurations: {
            create: {
              name: "Default Agent",
              isActive: true,
            },
          },
        },
      });

      if (body.ownerEmail) {
        const user = await prisma.user.findUnique({ where: { email: body.ownerEmail.toLowerCase() } });
        if (user) {
          await prisma.organisationMember.create({
            data: {
              organisationId: org.id,
              userId: user.id,
              role: MemberRole.OWNER,
            },
          });
        }
      }

      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.create",
        entityType: "Organisation",
        entityId: org.id,
        metadata: { name: org.name, slug: org.slug },
      });

      return Response.json({ ok: true, workspace: { id: org.id, name: org.name, slug: org.slug } });
    }

    const org = await prisma.organisation.findFirst({
      where: { id: body.organisationId, deletedAt: null },
    });
    if (!org) return jsonError("Workspace not found", 404);

    if (body.action === "suspend") {
      const updated = await prisma.organisation.update({
        where: { id: org.id },
        data: { status: OrganisationStatus.SUSPENDED, autopilotMode: "PAUSED" },
      });
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.suspend",
        entityType: "Organisation",
        entityId: org.id,
      });
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.action === "reactivate") {
      const updated = await prisma.organisation.update({
        where: { id: org.id },
        data: { status: OrganisationStatus.ACTIVE },
      });
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.reactivate",
        entityType: "Organisation",
        entityId: org.id,
      });
      return Response.json({ ok: true, status: updated.status });
    }

    const updated = await prisma.organisation.update({
      where: { id: org.id },
      data: {
        name: body.name ?? org.name,
        timezone: body.timezone ?? org.timezone,
        plan: body.plan ?? org.plan,
      },
    });
    await writeAuditLog({
      organisationId: org.id,
      userId: session.userId,
      action: "workspace.update",
      entityType: "Organisation",
      entityId: org.id,
      metadata: { name: updated.name, plan: updated.plan },
    });
    return Response.json({
      ok: true,
      workspace: { id: updated.id, name: updated.name, plan: updated.plan, timezone: updated.timezone },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError(error.errors[0]?.message || "Invalid request", 400);
    return jsonError(message, 500);
  }
}
