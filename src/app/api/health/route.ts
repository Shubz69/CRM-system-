import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { isProductionRuntime } from "@/lib/runtime";
import { pingRedis } from "@/jobs/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  const production = isProductionRuntime();
  const checks: Record<string, "ok" | "degraded" | "down"> = {
    database: "down",
    redis: "down",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "down";
  }

  const redisOk = await pingRedis();
  checks.redis = redisOk ? "ok" : "down";

  // Production: Redis is required — degraded Redis is a hard failure.
  // Non-production: Redis down is reported but does not fail the whole health check
  // (in-process follow-up fallback may still run locally).
  const ok =
    checks.database === "ok" && (production ? checks.redis === "ok" : true);

  return Response.json(
    {
      ok,
      status: ok ? "healthy" : "unhealthy",
      checks,
      redisRequired: production,
      demoMode: Boolean(env.DEMO_MODE),
      aiProvider: env.AI_PROVIDER,
      nodeEnv: env.NODE_ENV,
      queues: ["follow-ups", "agent-runs"],
    },
    { status: ok ? 200 : 503 },
  );
}
