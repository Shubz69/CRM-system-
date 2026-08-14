import { NextRequest } from "next/server";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";

const requestSchema = z.object({
  email: z.string().email(),
});

const resetSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(10).max(200),
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Request a password reset. Always returns ok to avoid email enumeration. */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`password-reset:${ip}`, 10, 60_000)) {
      return jsonError("Rate limit exceeded", 429);
    }

    const body = await req.json();
    if (body?.token && body?.password) {
      const parsed = resetSchema.parse(body);
      const tokenHash = hashToken(parsed.token);
      const record = await prisma.verificationToken.findFirst({
        where: { token: tokenHash },
      });
      if (!record || record.expires < new Date()) {
        return jsonError("Invalid or expired reset token", 400);
      }
      const bcrypt = await import("bcryptjs");
      const passwordHash = await bcrypt.hash(parsed.password, 12);
      const user = await prisma.user.findFirst({
        where: { email: record.identifier.toLowerCase(), deletedAt: null },
      });
      if (!user) return jsonError("Invalid or expired reset token", 400);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            mustChangePassword: false,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        }),
        prisma.verificationToken.deleteMany({ where: { identifier: record.identifier } }),
      ]);

      await writeAuditLog({
        scope: "PLATFORM",
        userId: user.id,
        action: "auth.password_reset_completed",
        entityType: "User",
        entityId: user.id,
      });

      return Response.json({ ok: true });
    }

    const { email } = requestSchema.parse(body);
    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null, isActive: true },
    });

    if (user) {
      const rawToken = randomBytes(32).toString("hex");
      const tokenHash = hashToken(rawToken);
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await prisma.verificationToken.deleteMany({ where: { identifier: user.email } });
      await prisma.verificationToken.create({
        data: {
          identifier: user.email,
          token: tokenHash,
          expires,
        },
      });
      await writeAuditLog({
        scope: "PLATFORM",
        userId: user.id,
        action: "auth.password_reset_requested",
        entityType: "User",
        entityId: user.id,
      });

      const env = getEnv();
      const resetUrl = `${(env.APP_URL || env.NEXTAUTH_URL).replace(/\/$/, "")}/reset-password?token=${rawToken}`;
      // Never log the token or password. Log only that email would be sent.
      logger.info("Password reset link generated", {
        userId: user.id,
        emailConfigured: Boolean(env.EMAIL_SMTP_URL),
      });
      // In local/dev without SMTP, return reset URL once for testing only.
      if (env.NODE_ENV !== "production") {
        return Response.json({
          ok: true,
          message: "If the account exists, a reset link was generated.",
          ...(env.NODE_ENV === "development" ? { resetUrl } : {}),
        });
      }
    }

    return Response.json({
      ok: true,
      message: "If the account exists, a reset link was generated.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    const message = error instanceof Error ? error.message : "Failed";
    return jsonError(message, 500);
  }
}
