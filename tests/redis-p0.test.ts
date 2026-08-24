import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Redis P0 guards", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults REDIS_URL to localhost when unset", async () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "development";
    const { getRedisUrl, isRemoteUpstashUrl } = await import("@/jobs/redis");
    expect(getRedisUrl()).toBe("redis://localhost:6379");
    expect(isRemoteUpstashUrl(getRedisUrl())).toBe(false);
  }, 15_000);

  it("refuses Upstash in development unless ALLOW_REMOTE_REDIS_IN_DEV", async () => {
    process.env.NODE_ENV = "development";
    process.env.APP_RUNTIME_MODE = "development";
    process.env.REDIS_URL = "rediss://default:secret@example.upstash.io:6379";
    delete process.env.ALLOW_REMOTE_REDIS_IN_DEV;
    const { assertRedisUrlAllowedForRuntime, RemoteRedisInDevError } = await import(
      "@/jobs/redis"
    );
    expect(() => assertRedisUrlAllowedForRuntime()).toThrow(RemoteRedisInDevError);
  });

  it("allows Upstash in development when ALLOW_REMOTE_REDIS_IN_DEV=true", async () => {
    process.env.NODE_ENV = "development";
    process.env.APP_RUNTIME_MODE = "development";
    process.env.REDIS_URL = "rediss://default:secret@example.upstash.io:6379";
    process.env.ALLOW_REMOTE_REDIS_IN_DEV = "true";
    const { assertRedisUrlAllowedForRuntime } = await import("@/jobs/redis");
    expect(() => assertRedisUrlAllowedForRuntime()).not.toThrow();
  });

  it("allows Upstash in production runtime without the opt-in flag", async () => {
    process.env.NODE_ENV = "production";
    process.env.APP_RUNTIME_MODE = "production";
    process.env.REDIS_URL = "rediss://default:secret@example.upstash.io:6379";
    delete process.env.ALLOW_REMOTE_REDIS_IN_DEV;
    const { assertRedisUrlAllowedForRuntime } = await import("@/jobs/redis");
    expect(() => assertRedisUrlAllowedForRuntime()).not.toThrow();
  });

  it("uses BullMQ prefix isolation without colon queue names", async () => {
    process.env.APP_RUNTIME_MODE = "test";
    delete process.env.QUEUE_PREFIX;
    const { getBullMqPrefix, getQueuePrefix, toSafeBullMqJobId, missionTaskJobId } = await import(
      "@/jobs/redis"
    );
    const { QUEUE_AGENT_RUNS, getBullMqSharedOptions } = await import("@/jobs/queues");
    expect(getBullMqPrefix()).toBe("agentdesk-test");
    expect(getQueuePrefix()).toBe("agentdesk-test");
    expect(QUEUE_AGENT_RUNS()).toBe("agent-runs");
    expect(QUEUE_AGENT_RUNS()).not.toContain(":");
    expect(getBullMqSharedOptions().prefix).toBe("agentdesk-test");
    expect(toSafeBullMqJobId("mission", "abc:def")).not.toContain(":");
    expect(missionTaskJobId("org1", "task1")).toBe("org-org1-task-task1");
    expect(missionTaskJobId("org1", "task1")).not.toContain(":");
  });

  it("isolates development preview and production prefixes", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    delete process.env.QUEUE_PREFIX;
    delete process.env.VERCEL_ENV;
    let mod = await import("@/jobs/redis");
    expect(mod.getBullMqPrefix()).toBe("agentdesk-dev");

    vi.resetModules();
    process.env.APP_RUNTIME_MODE = "production";
    mod = await import("@/jobs/redis");
    expect(mod.getBullMqPrefix()).toBe("agentdesk-prod");

    vi.resetModules();
    process.env.APP_RUNTIME_MODE = "development";
    process.env.VERCEL_ENV = "preview";
    mod = await import("@/jobs/redis");
    expect(mod.getBullMqPrefix()).toBe("agentdesk-preview");
  });

  it("Queue and Worker share the same BullMQ prefix helper", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    delete process.env.QUEUE_PREFIX;
    const { getBullMqPrefix } = await import("@/jobs/redis");
    const { getBullMqSharedOptions, QUEUE_AGENT_RUNS } = await import("@/jobs/queues");
    const shared = getBullMqSharedOptions();
    expect(shared.prefix).toBe(getBullMqPrefix());
    expect(QUEUE_AGENT_RUNS()).toBe("agent-runs");
  });

  it("honours explicit QUEUE_PREFIX without colons", async () => {
    process.env.QUEUE_PREFIX = "preview-pr-42";
    const { getBullMqPrefix } = await import("@/jobs/redis");
    expect(getBullMqPrefix()).toBe("preview-pr-42");
  });

  it("cronFallbackEnabled defaults false", async () => {
    delete process.env.CRON_FALLBACK_ENABLED;
    const { cronFallbackEnabled } = await import("@/jobs/redis");
    expect(cronFallbackEnabled()).toBe(false);
  });

  it("refuses duplicate worker start in-process", async () => {
    const {
      markWorkerStarted,
      markWorkerStopped,
      resetQueueOpsForTests,
    } = await import("@/services/queue-ops");
    resetQueueOpsForTests();
    markWorkerStarted({ queues: ["agent-runs"], prefix: "agentdesk-test" });
    expect(() =>
      markWorkerStarted({ queues: ["agent-runs"], prefix: "agentdesk-test" }),
    ).toThrow(/Duplicate worker start/);
    markWorkerStopped();
    expect(() =>
      markWorkerStarted({ queues: ["agent-runs"], prefix: "agentdesk-test" }),
    ).not.toThrow();
    markWorkerStopped();
  });

  it("enqueueFollowUpCheck is a no-op (no Redis repeatables)", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    const { enqueueFollowUpCheck } = await import("@/jobs/follow-ups");
    const result = await enqueueFollowUpCheck();
    expect(result.enqueued).toBe(false);
  });

  it("schedule:true retention does not enqueue Redis repeatables", async () => {
    process.env.APP_RUNTIME_MODE = "development";
    const { enqueueAgentRetentionSweep } = await import("@/jobs/maintenance");
    const result = await enqueueAgentRetentionSweep({ schedule: true });
    expect(result.enqueued).toBe(false);
  });
});
