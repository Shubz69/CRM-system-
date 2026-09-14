import { describe, expect, it } from "vitest";
import {
  hostedWorkerOpsMessage,
  isWorkerHeartbeatFresh,
  parseWorkerHeartbeat,
  shouldEnqueueDurableAgentRun,
  WORKER_HEARTBEAT_STALE_MS,
} from "@/services/worker-heartbeat";

describe("hosted worker heartbeat", () => {
  it("treats missing or stale beats as down", () => {
    const now = 1_000_000;
    expect(isWorkerHeartbeatFresh(null, now)).toBe(false);
    expect(isWorkerHeartbeatFresh(now - WORKER_HEARTBEAT_STALE_MS - 1, now)).toBe(false);
    expect(isWorkerHeartbeatFresh(now - 5_000, now)).toBe(true);
  });

  it("parses heartbeat JSON and rejects junk", () => {
    expect(parseWorkerHeartbeat(null)).toBeNull();
    expect(parseWorkerHeartbeat("{")).toBeNull();
    const ok = parseWorkerHeartbeat(
      JSON.stringify({
        ts: 123,
        instanceId: "w1",
        queues: ["agent-runs"],
        prefix: "agentdesk-prod",
      }),
    );
    expect(ok?.instanceId).toBe("w1");
    expect(ok?.queues).toEqual(["agent-runs"]);
  });
});

describe("Ask durable enqueue vs in-process", () => {
  it("never enqueues QUICK research even when the worker is live", () => {
    expect(
      shouldEnqueueDurableAgentRun({
        inProcessSync: true,
        answerMode: "QUICK",
        looksLikeResearch: true,
        hostedWorkerLive: true,
      }),
    ).toBe(false);
  });

  it("does not enqueue DEEP research when the hosted worker heartbeat is stale", () => {
    expect(
      shouldEnqueueDurableAgentRun({
        inProcessSync: false,
        answerMode: "DEEP",
        looksLikeResearch: true,
        hostedWorkerLive: false,
      }),
    ).toBe(false);
  });

  it("enqueues DEEP only when the hosted worker is live", () => {
    expect(
      shouldEnqueueDurableAgentRun({
        inProcessSync: false,
        answerMode: "DEEP",
        looksLikeResearch: true,
        hostedWorkerLive: true,
      }),
    ).toBe(true);
  });

  it("explains Redis-up / worker-down without claiming QUICK is blocked", () => {
    const msg = hostedWorkerOpsMessage({ redisOk: true, hostedWorkerLive: false });
    expect(msg).toMatch(/hosted worker is not running/i);
    expect(msg).toMatch(/QUICK Ask still runs/i);
    expect(msg).toMatch(/npm run worker/);
    expect(msg).not.toMatch(/QUICK Ask.*(blocked|required|stall)/i);
    expect(msg).toMatch(/falls back to local after/i);
  });
});
