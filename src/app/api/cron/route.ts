import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { isProductionRuntime } from "@/lib/runtime";
import { processDueFollowUps } from "@/workers/followups";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { cronFallbackEnabled } from "@/jobs/redis";

/**
 * Vercel Cron fallback — OFF by default when a hosted worker owns sweeps.
 * Set CRON_FALLBACK_ENABLED=true only if the worker process is unavailable.
 * Protect with CRON_SECRET (Authorization: Bearer …).
 */
function bearerMatches(header: string, secret: string): boolean {
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  // Nothing runs while the fallback is off, so there is nothing to protect yet.
  if (!cronFallbackEnabled()) {
    return Response.json({
      ok: true,
      skipped: true,
      reason:
        "CRON_FALLBACK_ENABLED is false — hosted worker owns follow-ups and insights. Set CRON_FALLBACK_ENABLED=true only as an explicit fallback.",
    });
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  // Fail closed in production: an unset CRON_SECRET used to leave this endpoint open.
  if (!secret && isProductionRuntime()) {
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (secret && !bearerMatches(auth, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sent = await processDueFollowUps();
    // Every active workspace, not an arbitrary first 100.
    const orgs = await prisma.organisation.findMany({
      where: { deletedAt: null, status: "ACTIVE" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const today = new Date();
    for (const org of orgs) {
      await aggregateDailyInsights(org.id, today);
    }
    return Response.json({ ok: true, followUpsSent: sent, orgsAggregated: orgs.length });
  } catch (error) {
    logger.error("Cron job failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Cron failed" }, { status: 500 });
  }
}
