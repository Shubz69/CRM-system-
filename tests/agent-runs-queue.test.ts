import { describe, expect, it, vi } from "vitest";

vi.mock("@/jobs/redis", () => ({
  pingRedis: vi.fn(async () => true),
  redisRequired: vi.fn(() => false),
  getRedisConnection: vi.fn(),
  assertRedisAllowedFallback: vi.fn(),
}));

const add = vi.fn(async () => ({ id: "job_sleep_1" }));

vi.mock("@/jobs/queues", () => ({
  getAgentRunsQueue: () => ({ add }),
  AGENT_RUN_JOB_OPTIONS: {},
}));

vi.mock("@/services/failed-jobs", () => ({
  recordFailedJob: vi.fn(async () => null),
}));

import { enqueueSleepTestJob } from "@/jobs/agent-runs";
import { processAgentRunJob } from "@/workers/agent-runs-processor";
import type { Job } from "bullmq";

describe("agent-runs queue (unit)", () => {
  it("enqueueSleepTestJob requires organisationId and returns a job id", async () => {
    add.mockClear();
    const result = await enqueueSleepTestJob({
      organisationId: "org_a",
      durationMs: 5_000,
      note: "unit",
    });
    expect(result.jobId).toBe("job_sleep_1");
    expect(result.durationMs).toBe(5_000);
    expect(add).toHaveBeenCalledWith(
      "sleep-test",
      expect.objectContaining({ organisationId: "org_a", durationMs: 5_000 }),
      expect.any(Object),
    );
  });

  it("processAgentRunJob noop returns ok for the given org", async () => {
    const job = {
      id: "1",
      name: "noop",
      data: { organisationId: "org_a", message: "hi" },
      attemptsMade: 0,
      updateProgress: vi.fn(),
    } as unknown as Job;

    const result = await processAgentRunJob(job);
    expect(result).toMatchObject({ ok: true, organisationId: "org_a" });
  });

  it("processAgentRunJob rejects missing organisationId", async () => {
    const job = {
      id: "2",
      name: "noop",
      data: {},
      attemptsMade: 0,
      updateProgress: vi.fn(),
    } as unknown as Job;

    await expect(processAgentRunJob(job)).rejects.toThrow(/organisationId/);
  });
});
