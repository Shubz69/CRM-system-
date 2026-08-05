import { Worker } from "bullmq";
import IORedis from "ioredis";
import { processDueFollowUps, startInProcessFollowUpLoop } from "./followups";
import { logger } from "@/lib/logger";

async function main() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  try {
    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    await connection.connect();
    await connection.ping();

    const worker = new Worker(
      "follow-ups",
      async () => {
        const sent = await processDueFollowUps();
        return { sent };
      },
      { connection },
    );

    worker.on("ready", () => logger.info("BullMQ follow-up worker ready"));
    worker.on("failed", (job, err) =>
      logger.error("Worker job failed", { jobId: job?.id, message: err.message }),
    );

    setInterval(() => {
      processDueFollowUps().catch((error) =>
        logger.error("Scheduled follow-up sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, 60_000);

    logger.info("Worker started with Redis");
  } catch {
    logger.warn("Redis unavailable — starting in-process follow-up loop");
    startInProcessFollowUpLoop(60_000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
