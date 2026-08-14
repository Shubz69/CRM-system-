import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { isProductionRuntime } from "@/lib/runtime";
import { pingRedis } from "@/jobs/redis";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const env = getEnv();
    const production = isProductionRuntime();
    const checks: Record<string, "ok" | "degraded" | "down"> = {
      database: "down",
      redis: "down",
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch (error) {
      logger.warn("Health check: database down", {
        message: error instanceof Error ? error.message : "unknown",
      });
      checks.database = "down";
    }

    try {
      const redisOk = await pingRedis();
      checks.redis = redisOk ? "ok" : "down";
    } catch (error) {
      logger.warn("Health check: redis probe threw", {
        message: error instanceof Error ? error.message : "unknown",
      });
      checks.redis = "down";
    }

    // Overall ok requires DB. Redis is required in production for workers,
    // but a Redis outage must not hide that Postgres is healthy.
    const databaseOk = checks.database === "ok";
    const redisOk = checks.redis === "ok";
    const ok = databaseOk && (production ? redisOk : true);

    return Response.json(
      {
        ok,
        status: ok ? "healthy" : "unhealthy",
        database: { ok: databaseOk },
        redis: { ok: redisOk },
        checks,
        redisRequired: production,
        aiProvider: env.AI_PROVIDER,
        nodeEnv: env.NODE_ENV,
        queues: ["follow-ups", "agent-runs", "maintenance"],
        embeddingProvider: env.EMBEDDING_PROVIDER,
      },
      { status: ok ? 200 : 503 },
    );
  } catch (error) {
    logger.error("Health check failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json(
      {
        ok: false,
        status: "unhealthy",
        database: { ok: false },
        redis: { ok: false },
        checks: { database: "down", redis: "down" },
        error: "Health check failed",
      },
      { status: 503 },
    );
  }
}
