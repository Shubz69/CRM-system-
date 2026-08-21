import { NextRequest } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { getEmailAdapter } from "@/adapters/email";

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

function secretsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function bootstrapAuthorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expected || expected.length < 16) return false;
  const header = req.headers.get("x-admin-bootstrap-secret") || "";
  return secretsEqual(header, expected);
}

function humanizeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("ecircuitbreaker") ||
    lower.includes("failed to retrieve database credentials")
  ) {
    return "Database credentials are blocked (Supabase circuit breaker). Reset the database password in Supabase, update DATABASE_URL on Vercel with URL-encoded special characters, wait a few minutes, then redeploy.";
  }
  if (
    lower.includes("provided database string is invalid") ||
    lower.includes("arguments are not supported in database url") ||
    (lower.includes("invalid prisma") && lower.includes("database string"))
  ) {
    return "DATABASE_URL is invalid. URL-encode special characters in the password (! → %21, @ → %40) and use the Transaction pooler on port 6543.";
  }
  if (
    lower.includes("can't reach database") ||
    lower.includes("connection timed out") ||
    lower.includes("connection pool") ||
    lower.includes("p1001") ||
    lower.includes("p1002") ||
    lower.includes("p2024")
  ) {
    return "Cannot reach the database. Check DATABASE_URL (Supabase Transaction pooler :6543) and that the project is not paused.";
  }
  if (lower.includes("authentication failed") || lower.includes("password authentication")) {
    return "Database password rejected. Reset the DB password in Supabase and update DATABASE_URL / DIRECT_URL on Vercel.";
  }
  // Avoid dumping raw Prisma stacks to the client.
  return "Password reset failed while talking to the database. Check Vercel DATABASE_URL and Supabase status.";
}

/** Request a password reset. Always returns ok to avoid email enumeration (unless bootstrap recovery). */
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
    const env = getEnv();
    const allowInlineLink =
      env.NODE_ENV === "development" || bootstrapAuthorized(req);

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

      const base = (env.APP_URL || env.NEXTAUTH_URL || "").replace(/\/$/, "");
      const resetUrl = `${base}/reset-password?token=${rawToken}`;

      let emailed = false;
      if (env.EMAIL_SMTP_URL) {
        const delivery = await getEmailAdapter().send({
          organisationId: "platform",
          to: [user.email],
          subject: "Reset your Agent Desk password",
          bodyText: [
            "You requested a password reset for Agent Desk.",
            "",
            `Open this link within 1 hour to set a new password:`,
            resetUrl,
            "",
            "If you did not request this, you can ignore this email.",
          ].join("\n"),
          metadata: { kind: "password_reset" },
        });
        emailed = delivery.ok;
        if (!delivery.ok) {
          logger.error("Password reset email failed", {
            userId: user.id,
            error: delivery.error,
          });
        }
      }

      logger.info("Password reset link generated", {
        userId: user.id,
        emailConfigured: Boolean(env.EMAIL_SMTP_URL),
        emailed,
        inlineLink: allowInlineLink,
      });

      if (allowInlineLink) {
        return Response.json({
          ok: true,
          message: emailed
            ? "Reset email sent. A recovery link is also shown below."
            : env.EMAIL_SMTP_URL
              ? "Email send failed — use the recovery link below."
              : "Email is not configured — use the recovery link below.",
          resetUrl,
          emailed,
        });
      }

      if (env.EMAIL_SMTP_URL && !emailed) {
        return jsonError(
          "Could not send the reset email. Check EMAIL_SMTP_URL / EMAIL_FROM on the server, or retry with the admin bootstrap secret to get a recovery link.",
          503,
        );
      }
    } else if (allowInlineLink) {
      // Ops recovery: do not pretend success when they authenticated with bootstrap secret.
      return jsonError("No active user found for that email.", 404);
    }

    return Response.json({
      ok: true,
      message: "If the account exists, a reset link was generated.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    logger.error("Password reset failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return jsonError(humanizeDbError(error), 500);
  }
}
