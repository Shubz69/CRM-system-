import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue, Worker } from "bullmq";

describe("BullMQ prefix isolation (no colon queue names)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.QUEUE_PREFIX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("logical queue names never contain a colon", async () => {
    const { QUEUE_AGENT_RUNS, QUEUE_FOLLOW_UPS, QUEUE_MAINTENANCE } = await import(
      "@/jobs/queues"
    );
    for (const name of [QUEUE_AGENT_RUNS(), QUEUE_FOLLOW_UPS(), QUEUE_MAINTENANCE()]) {
      expect(name).not.toContain(":");
    }
    expect(QUEUE_AGENT_RUNS()).toBe("agent-runs");
    expect(QUEUE_FOLLOW_UPS()).toBe("follow-ups");
    expect(QUEUE_MAINTENANCE()).toBe("maintenance");
  });

  it("development / test / production prefixes are isolated", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    vi.resetModules();
    expect((await import("@/jobs/redis")).getBullMqPrefix()).toBe("agentdesk-dev");

    process.env.APP_RUNTIME_MODE = "test";
    vi.resetModules();
    expect((await import("@/jobs/redis")).getBullMqPrefix()).toBe("agentdesk-test");

    process.env.APP_RUNTIME_MODE = "production";
    vi.resetModules();
    expect((await import("@/jobs/redis")).getBullMqPrefix()).toBe("agentdesk-prod");
  });

  it("Queue and Worker resolve the same prefix", async () => {
    process.env.APP_RUNTIME_MODE = "test";
    delete process.env.QUEUE_PREFIX;
    const { getBullMqPrefix } = await import("@/jobs/redis");
    const { getBullMqSharedOptions, QUEUE_AGENT_RUNS } = await import("@/jobs/queues");

    const prefix = getBullMqPrefix();
    expect(prefix).toBe("agentdesk-test");
    expect(getBullMqSharedOptions().prefix).toBe(prefix);

    const connection = { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null as null };
    const queue = new Queue(QUEUE_AGENT_RUNS(), { connection, prefix });
    const worker = new Worker(QUEUE_AGENT_RUNS(), async () => undefined, {
      connection,
      prefix,
    });

    expect(queue.name).toBe("agent-runs");
    expect(queue.name).not.toContain(":");
    expect(worker.name).toBe("agent-runs");
    expect(worker.name).not.toContain(":");
    // BullMQ stores prefix on opts
    expect((queue as unknown as { opts: { prefix: string } }).opts.prefix).toBe(prefix);
    expect((worker as unknown as { opts: { prefix: string } }).opts.prefix).toBe(prefix);

    await worker.close();
    await queue.close();
  });

  it("colon-in-queue-name construction is rejected by BullMQ", () => {
    const connection = { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null as null };
    expect(() => new Queue("dev:agent-runs", { connection })).toThrow(/cannot contain/i);
  });

  it("mission job IDs contain no colon", async () => {
    const { missionAgentRunJobId, missionTaskJobId, toSafeBullMqJobId } = await import(
      "@/jobs/redis"
    );
    const missionId = missionAgentRunJobId("org_1", "mission_9");
    const taskId = missionTaskJobId("org_1", "task_3");
    expect(missionId).toBe("org-org_1-mission-mission_9-agent-run");
    expect(taskId).toBe("org-org_1-task-task_3");
    expect(missionId).not.toContain(":");
    expect(taskId).not.toContain(":");
    expect(toSafeBullMqJobId("mission:abc", "task:def")).toBe("mission-abc-task-def");
    expect(toSafeBullMqJobId("mission:abc", "task:def")).not.toContain(":");
  });

  it("worker can construct Queue+Worker against local Redis without colon error", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    delete process.env.QUEUE_PREFIX;
    const { getBullMqPrefix } = await import("@/jobs/redis");
    const { QUEUE_AGENT_RUNS } = await import("@/jobs/queues");
    const prefix = getBullMqPrefix();
    expect(prefix).toBe("agentdesk-dev");

    const connection = { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null as null };
    let queue: Queue | null = null;
    let worker: Worker | null = null;
    try {
      queue = new Queue(QUEUE_AGENT_RUNS(), { connection, prefix });
      worker = new Worker(QUEUE_AGENT_RUNS(), async () => undefined, { connection, prefix });
      expect(queue.name).toBe("agent-runs");
    } finally {
      await worker?.close().catch(() => undefined);
      await queue?.close().catch(() => undefined);
    }
  });
});
