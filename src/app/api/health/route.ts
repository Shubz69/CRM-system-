import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import IORedis from "ioredis";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  const checks: Record<string, "ok" | "degraded" | "down"> = {
    database: "down",
    redis: "degraded",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "down";
  }

  try {
    const redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
    });
    await redis.connect();
    const pong = await redis.ping();
    checks.redis = pong === "PONG" ? "ok" : "degraded";
    await redis.quit().catch(() => undefined);
  } catch {
    checks.redis = "degraded";
  }

  const ok = checks.database === "ok";
  return Response.json(
    {
      ok,
      status: ok ? "healthy" : "unhealthy",
      checks,
      demoMode: Boolean(env.DEMO_MODE),
      aiProvider: env.AI_PROVIDER,
      nodeEnv: env.NODE_ENV,
    },
    { status: ok ? 200 : 503 },
  );
}
