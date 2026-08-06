import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { seedSuperAdmin } from "@/services/seed-admin";
import { prisma } from "@/lib/db";

function secretsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Idempotent admin bootstrap for hosted environments (Vercel).
 * Requires header x-admin-bootstrap-secret matching ADMIN_BOOTSTRAP_SECRET.
 * Reads ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD from server env only — never from the request body.
 * Never returns the password.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`admin-bootstrap:${ip}`, 5, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    const bootstrapSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
    if (!bootstrapSecret || bootstrapSecret.length < 16) {
      return Response.json(
        {
          error:
            "Bootstrap disabled. Set ADMIN_BOOTSTRAP_SECRET (16+ chars) and ADMIN_INITIAL_PASSWORD in Vercel env, then redeploy.",
        },
        { status: 503 },
      );
    }

    const header = req.headers.get("x-admin-bootstrap-secret") || "";
    if (!secretsEqual(header, bootstrapSecret)) {
      return Response.json({ error: "Invalid bootstrap secret" }, { status: 401 });
    }

    if (!process.env.ADMIN_INITIAL_PASSWORD) {
      return Response.json(
        { error: "ADMIN_INITIAL_PASSWORD is not configured on the server" },
        { status: 503 },
      );
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return Response.json(
        { error: "Database is not connected. Set DATABASE_URL in Vercel and redeploy." },
        { status: 503 },
      );
    }

    const result = await seedSuperAdmin({
      email: env.ADMIN_EMAIL || "1230shobhit@gmail.com",
      forcePasswordChange: env.ADMIN_FORCE_PASSWORD_CHANGE !== false,
    });

    logger.info("Admin bootstrap completed", {
      email: result.email,
      created: result.created,
      updated: result.updated,
    });

    return Response.json({
      ok: true,
      email: result.email,
      created: result.created,
      updated: result.updated,
      message:
        "Super admin is ready. Sign in with ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD, then change the password if prompted. Rotate ADMIN_BOOTSTRAP_SECRET after use.",
    });
  } catch (error) {
    logger.error("Admin bootstrap failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Bootstrap failed" }, { status: 500 });
  }
}

export async function GET() {
  let databaseOk = false;
  let adminExists = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
    const email = (process.env.ADMIN_EMAIL || "1230shobhit@gmail.com").toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, isPlatformAdmin: true, isActive: true },
    });
    adminExists = Boolean(user?.isPlatformAdmin && user.isActive);
  } catch {
    databaseOk = false;
  }

  return Response.json({
    databaseOk,
    adminExists,
    bootstrapConfigured: Boolean(process.env.ADMIN_BOOTSTRAP_SECRET),
    adminPasswordConfigured: Boolean(process.env.ADMIN_INITIAL_PASSWORD),
    adminEmail: process.env.ADMIN_EMAIL || "1230shobhit@gmail.com",
  });
}
