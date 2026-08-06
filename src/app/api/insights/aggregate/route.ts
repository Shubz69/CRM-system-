import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  date: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requirePermission("insights:read");
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    const date = body.date ? new Date(body.date) : new Date();
    const metric = await aggregateDailyInsights(session.organisationId, date);
    return Response.json({ ok: true, metric });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function GET(req: Request) {
  try {
    const session = await requirePermission("insights:read");
    const { searchParams } = new URL(req.url);
    const days = Math.min(Number(searchParams.get("days") || 7), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const metrics = await prisma.dailyMetric.findMany({
      where: { organisationId: session.organisationId, date: { gte: since } },
      orderBy: { date: "desc" },
    });
    return Response.json({ metrics });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
