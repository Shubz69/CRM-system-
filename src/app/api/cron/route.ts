import { NextRequest } from "next/server";
import { processDueFollowUps } from "@/workers/followups";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Vercel Cron entrypoint for follow-ups + daily insights when a long-running worker is unavailable.
 * Protect with CRON_SECRET (Authorization: Bearer …).
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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
