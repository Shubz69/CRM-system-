import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertRedisCircuitAllowsWork,
  clearRedisCircuit,
  getRedisCircuitSnapshot,
  getRedisCircuitState,
  isFatalRedisProviderError,
  isRedisCircuitOpen,
  noteRedisError,
  resetRedisCircuitForTests,
  setRedisCircuitHooks,
} from "@/jobs/redis-circuit";
import { recoverMissionQueueJobs } from "@/services/domain-events/mission-queue-recovery";

describe("redis fatal provider circuit", () => {
  beforeEach(() => {
    resetRedisCircuitForTests();
  });

  afterEach(() => {
    resetRedisCircuitForTests();
  });

  it("recognises Upstash quota error as fatal (case-insensitive)", () => {
    expect(
      isFatalRedisProviderError(new Error("ERR max requests limit exceeded")),
    ).toBe(true);
    expect(
      isFatalRedisProviderError(new Error("Error: err Max Requests Limit Exceeded.")),
    ).toBe(true);
    expect(isFatalRedisProviderError("max requests limit exceeded")).toBe(true);
  });

  it("does not treat transient connection errors as fatal", () => {
    expect(isFatalRedisProviderError(new Error("ECONNRESET"))).toBe(false);
    expect(isFatalRedisProviderError(new Error("Connection is closed."))).toBe(false);
    expect(isFatalRedisProviderError(new Error("connect ETIMEDOUT"))).toBe(false);
    expect(isFatalRedisProviderError(new Error("WRONGTYPE Operation against a key"))).toBe(
      false,
    );
  });

  it("opens circuit once and suppresses repeated transitions", () => {
    const onOpen = vi.fn();
    setRedisCircuitHooks({ onOpen });

    expect(noteRedisError(new Error("ERR max requests limit exceeded"))).toBe(true);
    expect(getRedisCircuitState()).toBe("OPEN");
    expect(onOpen).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 99; i++) {
      expect(noteRedisError(new Error("ERR max requests limit exceeded"))).toBe(false);
    }

    const snap = getRedisCircuitSnapshot();
    expect(snap.openTransitionCount).toBe(1);
    expect(snap.suppressedWhileOpen).toBe(99);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("100 fatal errors do not produce 100 Redis-side Agent Desk loop calls after open", async () => {
    let redisOps = 0;
    const pause = vi.fn(async () => {
      redisOps += 1; // stand-in for "stop pulling" side effect once
    });
    setRedisCircuitHooks({
      onOpen: async () => {
        await pause();
      },
    });

    for (let i = 0; i < 100; i++) {
      noteRedisError(new Error("ERR max requests limit exceeded"));
      // Simulate Agent Desk–owned mission recovery gate
      if (!isRedisCircuitOpen()) {
        redisOps += 1;
      }
    }

    expect(isRedisCircuitOpen()).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    // One pause side-effect only — no 100 Redis ops from our loops
    expect(redisOps).toBe(1);
    expect(getRedisCircuitSnapshot().suppressedWhileOpen).toBe(99);
  });

  it("enqueue fail-closed while circuit open (assertRedisCircuitAllowsWork)", () => {
    noteRedisError(new Error("ERR max requests limit exceeded"));
    expect(() => assertRedisCircuitAllowsWork()).toThrow(/circuit is OPEN/i);
  });

  it("mission queue recovery is suppressed while circuit open (no Redis getJob)", async () => {
    noteRedisError(new Error("ERR max requests limit exceeded"));
    const result = await recoverMissionQueueJobs();
    expect(result).toEqual({ examined: 0, enqueued: 0, skipped: 0 });
  });

  it("clears circuit on recovery and invokes onRecover once", () => {
    let recovered = 0;
    setRedisCircuitHooks({
      onOpen: null,
      onRecover: () => {
        recovered += 1;
      },
    });
    expect(noteRedisError(new Error("ERR max requests limit exceeded"))).toBe(true);
    expect(clearRedisCircuit("recovery_probe_ok")).toBe(true);
    expect(getRedisCircuitState()).toBe("CLOSED");
    expect(recovered).toBe(1);
    expect(clearRedisCircuit("again")).toBe(false);
    expect(recovered).toBe(1);
  });

  it("does not open circuit on non-fatal errors", () => {
    expect(noteRedisError(new Error("ECONNRESET"))).toBe(false);
    expect(isRedisCircuitOpen()).toBe(false);
  });

  it("does not process.exit on fatal quota — process stays alive (degraded)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    noteRedisError(new Error("ERR max requests limit exceeded"));
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("BullMQ pause mechanism contract (installed Worker API)", () => {
  it("documents that pause(true) is the stop mechanism used by the worker", async () => {
    // Import types only — proves Worker exposes pause/isPaused/resume used by workers/index.ts
    const { Worker } = await import("bullmq");
    expect(typeof Worker.prototype.pause).toBe("function");
    expect(typeof Worker.prototype.resume).toBe("function");
    expect(typeof Worker.prototype.isPaused).toBe("function");
  });
});
