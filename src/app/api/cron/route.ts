import { NextRequest } from "next/server";
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
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!cronFallbackEnabled()) {
    return Response.json({
      ok: true,
      skipped: true,
      reason:
        "CRON_FALLBACK_ENABLED is false — hosted worker owns follow-ups and insights. Set CRON_FALLBACK_ENABLED=true only as an explicit fallback.",
    });
  }

  try {
    const sent = await processDueFollowUps();
    const orgs = await prisma.organisation.findMany({
      where: { deletedAt: null },
      select: { id: true },
      take: 100,
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
