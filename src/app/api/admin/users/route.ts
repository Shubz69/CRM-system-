import { NextRequest } from "next/server";
import { z } from "zod";
import { MemberRole } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { getEnv } from "@/lib/env";
import { getEmailAdapter } from "@/adapters/email";
import { logger } from "@/lib/logger";

const mutateSchema = z.object({
  action: z.enum([
    "suspend",
    "reactivate",
    "change_role",
    "revoke_sessions",
    "verify",
    "send_password_reset",
  ]),
  userId: z.string().min(1),
  organisationId: z.string().optional(),
  role: z.nativeEnum(MemberRole).optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAccess();
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const role = searchParams.get("role");
    const status = searchParams.get("status");
    const organisationId = searchParams.get("organisationId");

    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { email: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(status === "suspended" ? { isSuspended: true } : {}),
        ...(status === "active" ? { isSuspended: false, isActive: true } : {}),
        ...(organisationId || role
          ? {
              memberships: {
                some: {
                  ...(organisationId ? { organisationId } : {}),
                  ...(role ? { role: role as MemberRole } : {}),
                },
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        memberships: {
          include: { organisation: { select: { id: true, name: true, slug: true } } },
        },
        sessions: { select: { id: true, expires: true }, take: 10 },
      },
    });

    return Response.json({
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        isActive: user.isActive,
        isSuspended: user.isSuspended,
        isPlatformAdmin: user.isPlatformAdmin,
        emailVerified: user.emailVerified?.toISOString() ?? null,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        lockedUntil: user.lockedUntil?.toISOString() ?? null,
        activeSessions: user.sessions.filter((s) => s.expires > new Date()).length,
        memberships: user.memberships.map((m) => ({
          organisationId: m.organisationId,
          organisationName: m.organisation.name,
          role: m.role,
        })),
      })),
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
    const body = mutateSchema.parse(await req.json());

    const user = await prisma.user.findFirst({
      where: { id: body.userId, deletedAt: null },
      include: { memberships: true },
    });
    if (!user) return jsonError("User not found", 404);
    if (user.id === session.userId && (body.action === "suspend" || body.action === "revoke_sessions")) {
      return jsonError("Cannot perform this action on your own account", 400);
    }
    if (user.isPlatformAdmin && body.action === "suspend") {
      return jsonError("Cannot suspend another platform administrator", 403);
    }

    if (body.action === "suspend") {
      await prisma.user.update({
        where: { id: user.id },
        data: { isSuspended: true },
      });
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await writeAuditLog({
        organisationId: body.organisationId || session.organisationId,
        userId: session.userId,
        action: "user.suspend",
        entityType: "User",
        entityId: user.id,
      });
      return Response.json({ ok: true });
    }

    if (body.action === "reactivate") {
      await prisma.user.update({
        where: { id: user.id },
        data: { isSuspended: false, isActive: true, failedLoginAttempts: 0, lockedUntil: null },
      });
      await writeAuditLog({
        organisationId: body.organisationId || session.organisationId,
        userId: session.userId,
        action: "user.reactivate",
        entityType: "User",
        entityId: user.id,
      });
      return Response.json({ ok: true });
    }

    if (body.action === "revoke_sessions") {
      const result = await prisma.session.deleteMany({ where: { userId: user.id } });
      await writeAuditLog({
        organisationId: body.organisationId || session.organisationId,
        userId: session.userId,
        action: "user.revoke_sessions",
        entityType: "User",
        entityId: user.id,
        metadata: { deleted: result.count },
      });
      return Response.json({ ok: true, deleted: result.count });
    }

    if (body.action === "verify") {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() },
      });
      await writeAuditLog({
        organisationId: body.organisationId || session.organisationId,
        userId: session.userId,
        action: "user.verify",
        entityType: "User",
        entityId: user.id,
      });
      return Response.json({ ok: true });
    }

    if (body.action === "change_role") {
      if (!body.organisationId || !body.role) {
        return jsonError("organisationId and role are required", 400);
      }
      if (body.role === MemberRole.SUPER_ADMIN && !session.isPlatformAdmin) {
        return jsonError("Only platform admins can assign SUPER_ADMIN", 403);
      }
      const membership = await prisma.organisationMember.findUnique({
        where: {
          organisationId_userId: {
            organisationId: body.organisationId,
            userId: user.id,
          },
        },
      });
      if (!membership) return jsonError("User is not a member of that workspace", 404);
      await prisma.organisationMember.update({
        where: { id: membership.id },
        data: { role: body.role },
      });
      await writeAuditLog({
        organisationId: body.organisationId,
        userId: session.userId,
        action: "user.role_change",
        entityType: "User",
        entityId: user.id,
        metadata: { from: membership.role, to: body.role },
      });
      return Response.json({ ok: true });
    }

    // Force password change on next login; issue one-time reset token for /reset-password flows.
    // Must match /api/auth/password-reset: identifier = email, token = sha256(raw).
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.verificationToken.deleteMany({ where: { identifier: user.email } });
    await prisma.verificationToken.create({
      data: {
        identifier: user.email,
        token: tokenHash,
        expires,
      },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });

    const env = getEnv();
    const base = (env.APP_URL || env.NEXTAUTH_URL || "").replace(/\/$/, "");
    const resetUrl = base ? `${base}/reset-password?token=${rawToken}` : null;
    let emailed = false;
    if (env.EMAIL_SMTP_URL && resetUrl) {
      const delivery = await getEmailAdapter().send({
        organisationId: body.organisationId || session.organisationId || "platform",
        to: [user.email],
        subject: "Reset your Agent Desk password",
        bodyText: [
          "An administrator issued a password reset for your Agent Desk account.",
          "",
          `Open this link within 1 hour to set a new password:`,
          resetUrl,
          "",
          "If you did not expect this, contact your administrator.",
        ].join("\n"),
        metadata: { kind: "password_reset_admin" },
      });
      emailed = delivery.ok;
      if (!delivery.ok) {
        logger.error("Admin-issued password reset email failed", {
          userId: user.id,
          error: delivery.error,
        });
      }
    }

    await writeAuditLog({
      organisationId: body.organisationId || session.organisationId,
      userId: session.userId,
      action: "user.password_reset_issued",
      entityType: "User",
      entityId: user.id,
      metadata: {
        expires: expires.toISOString(),
        tokenIssued: true,
        emailed,
      },
    });
    return Response.json({
      ok: true,
      resetToken: rawToken,
      resetUrl,
      emailed,
      expiresAt: expires.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
