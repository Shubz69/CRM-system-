import { NextRequest } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/session-security";
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
  if (
    lower.includes("authentication failed") ||
    lower.includes("password authentication") ||
    (lower.includes("credentials") && lower.includes("not valid")) ||
    lower.includes("eauthquery") ||
    lower.includes("user not found in the database")
  ) {
    return "Database login rejected. In DATABASE_URL the user must be postgres.<project-ref> (not pos0tgres…) and the password must match Supabase → Settings → Database. URL-encode special characters, then redeploy.";
  }
  // Avoid dumping raw Prisma stacks to the client.
  return "Password reset failed while talking to the database. Check Vercel DATABASE_URL and Supabase status.";
}

/** Same body for existing and unknown emails, so the response never reveals an account. */
const GENERIC_REQUEST_RESPONSE = {
  ok: true,
  message: "If the account exists, a reset link was sent by email.",
};

/**
 * Request or complete a password reset.
 * Request path: emails a link when SMTP is configured; fails closed (503) when it is not
 * (unless local/dev or ADMIN_BOOTSTRAP_SECRET unlocks an inline recovery link).
 * With SMTP configured, existing and unknown emails get the same generic ok — including when
 * sending to an existing account fails (logged server-side) — so accounts can't be enumerated.
 * Throttled per client IP (first X-Forwarded-For hop), per email, and per reset token.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req.headers.get("x-forwarded-for"));
    if (!rateLimit(`password-reset:${ip}`, 10, 60_000)) {
      return jsonError("Rate limit exceeded", 429);
    }

    const body = await req.json();
    if (body?.token && body?.password) {
      const parsed = resetSchema.parse(body);
      const tokenHash = hashToken(parsed.token);
      if (!rateLimit(`password-reset:token:${tokenHash}`, 5, 60 * 60_000)) {
        return jsonError("Too many attempts with this reset link. Request a new one later.", 429);
      }
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
    // Per-email cap stops one inbox being flooded with reset mail from many IPs. Applies to
    // every address alike, so it says nothing about which accounts exist.
    if (!rateLimit(`password-reset:email:${hashToken(email.toLowerCase())}`, 5, 60 * 60_000)) {
      return jsonError("Too many reset requests for this email. Try again later.", 429);
    }
    const env = getEnv();
    const allowInlineLink =
      env.NODE_ENV === "development" || bootstrapAuthorized(req);
    const smtpConfigured = Boolean(env.EMAIL_SMTP_URL?.trim());

    // Production without SMTP cannot deliver mail — never pretend a reset was emailed.
    // Bootstrap / local dev may still return an inline recovery link.
    if (!smtpConfigured && !allowInlineLink) {
      return jsonError(
        "Password reset email is not configured. Set EMAIL_SMTP_URL and EMAIL_FROM on the server, or open «No email yet? Use recovery secret» and paste ADMIN_BOOTSTRAP_SECRET to get a one-time reset link.",
        503,
      );
    }

    const configuredBase = (env.APP_URL || env.NEXTAUTH_URL || "").replace(/\/$/, "");
    // Emails need the public site URL; inline recovery can fall back to this request's origin.
    // Checked before the user lookup so this config error looks the same for every email.
    if (!configuredBase && !allowInlineLink) {
      logger.error("Password reset blocked: APP_URL / NEXTAUTH_URL missing");
      return jsonError(
        "Password reset email cannot be built: set APP_URL (or NEXTAUTH_URL) to the public site URL, then retry.",
        503,
      );
    }

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

      const base = configuredBase || req.nextUrl.origin;
      const resetUrl = `${base}/reset-password?token=${rawToken}`;
      const canEmail = smtpConfigured && Boolean(configuredBase);

      let emailed = false;
      let emailError: string | undefined;
      if (canEmail) {
        try {
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
          emailError = delivery.error;
        } catch (error) {
          emailError = error instanceof Error ? error.message : "Email send threw";
        }
        if (!emailed) {
          logger.error("Password reset email failed", {
            userId: user.id,
            error: emailError,
          });
        }
      } else if (smtpConfigured && !configuredBase) {
        emailError = "APP_URL / NEXTAUTH_URL is not set — cannot email a public reset link";
      }

      logger.info("Password reset link generated", {
        userId: user.id,
        emailConfigured: smtpConfigured,
        emailed,
        inlineLink: allowInlineLink,
      });

      if (allowInlineLink) {
        return Response.json({
          ok: true,
          message: emailed
            ? "Reset email sent. A recovery link is also shown below."
            : smtpConfigured
              ? "Email send failed — use the recovery link below."
              : "Email is not configured — use the recovery link below.",
          resetUrl,
          emailed,
          ...(emailError && !emailed ? { emailError } : {}),
        });
      }

      // A failed send is logged above, never surfaced: answering differently for an existing
      // account than for an unknown email would reveal which emails have accounts.
      return Response.json(GENERIC_REQUEST_RESPONSE);
    }

    if (allowInlineLink) {
      // Ops recovery: do not pretend success when they authenticated with bootstrap secret.
      return jsonError("No active user found for that email.", 404);
    }

    // No matching active user — answer exactly as for an existing one.
    return Response.json(GENERIC_REQUEST_RESPONSE);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    logger.error("Password reset failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return jsonError(humanizeDbError(error), 500);
  }
}
