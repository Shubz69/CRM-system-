import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failedJobFindUnique: vi.fn(),
  failedJobUpdateMany: vi.fn(),
  followUpFindFirst: vi.fn(),
  followUpUpdateMany: vi.fn(),
  outboundDispatchFindUnique: vi.fn(),
  agentRunFindFirst: vi.fn(),
  enqueueAgentRunJob: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    failedJob: {
      findUnique: mocks.failedJobFindUnique,
      updateMany: mocks.failedJobUpdateMany,
      update: vi.fn(),
    },
    followUp: { findFirst: mocks.followUpFindFirst, updateMany: mocks.followUpUpdateMany },
    outboundDispatch: { findUnique: mocks.outboundDispatchFindUnique },
    agentRun: { findFirst: mocks.agentRunFindFirst },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/platform-org", () => ({ getPlatformOrganisationId: vi.fn(async () => "org_platform") }));
vi.mock("@/lib/session", () => ({
  requirePlatformAccess: vi.fn(async () => ({ userId: "admin_1", organisationId: "org_platform" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/jobs/agent-runs", async () => {
  const { z } = await import("zod");
  return {
    agentRunJobNameSchema: z.enum([
      "sleep-test",
      "noop",
      "agent-framework-run",
      "agent-retention-sweep",
      "knowledge-embedding-backfill",
    ]),
    enqueueAgentRunJob: (...args: unknown[]) => mocks.enqueueAgentRunJob(...args),
  };
});

import { POST } from "@/app/api/admin/failed-jobs/route";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "fj_1",
    organisationId: "org_salon",
    queue: "follow-ups",
    jobName: "send-followup",
    payload: { followUpId: "fu_1" },
    error: "PROVIDER_TIMEOUT",
    attempts: 1,
    createdAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

function retry(jobId = "fj_1") {
  return POST(
    new Request("http://localhost/api/admin/failed-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", jobId }),
    }) as never,
  );
}

describe("admin failed-job retry re-runs the work before resolving", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failedJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.followUpUpdateMany.mockResolvedValue({ count: 1 });
    mocks.outboundDispatchFindUnique.mockResolvedValue(null);
  });

  it("puts a failed follow-up back on the schedule, then resolves the job", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(job());
    mocks.followUpFindFirst.mockResolvedValue({ id: "fu_1", status: "FAILED", cancelReason: null });

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.message).toMatch(/re-queued/i);
    expect(mocks.followUpFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fu_1", organisationId: "org_salon" } }),
    );
    expect(mocks.followUpUpdateMany).toHaveBeenCalledWith({
      where: { id: "fu_1", status: "FAILED" },
      data: expect.objectContaining({ status: "SCHEDULED", scheduledFor: expect.any(Date) }),
    });
    expect(mocks.failedJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "fj_1", resolvedAt: null },
        data: expect.objectContaining({ resolvedAt: expect.any(Date) }),
      }),
    );
  });

  it("never re-sends a follow-up the provider rejected — the job stays open", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(job());
    mocks.followUpFindFirst.mockResolvedValue({ id: "fu_1", status: "FAILED", cancelReason: null });
    mocks.outboundDispatchFindUnique.mockResolvedValue({ externalOutcome: "RECONCILIATION_REQUIRED" });

    const res = await retry();

    expect(res.status).toBe(409);
    expect(mocks.followUpUpdateMany).not.toHaveBeenCalled();
    expect(mocks.failedJobUpdateMany).not.toHaveBeenCalled();
  });

  it("says a job type can't be retried and leaves it open", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(
      job({ queue: "ai-reply", jobName: "generate-reply", payload: { conversationId: "c1" } }),
    );

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toMatch(/isn't supported/i);
    expect(mocks.failedJobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("re-enqueues an agent-runs job with its original input (worker 'failed' hook shape)", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(
      job({
        queue: "agent-runs",
        jobName: "noop",
        payload: {
          jobId: "123",
          data: { organisationId: "org_salon", message: "hi", enqueuedAt: "2026-11-15T00:00:00Z" },
        },
      }),
    );
    mocks.enqueueAgentRunJob.mockResolvedValue({ jobId: "failed-job-retry-fj_1" });

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.requeuedJobId).toBe("failed-job-retry-fj_1");
    expect(mocks.enqueueAgentRunJob).toHaveBeenCalledWith({
      name: "noop",
      organisationId: "org_salon",
      payload: { organisationId: "org_salon", message: "hi" },
      opts: { jobId: "failed-job-retry-fj_1" },
    });
    expect(mocks.failedJobUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("does not pretend to retry an agent run that already ended", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(
      job({
        queue: "agent-runs",
        jobName: "agent-framework-run",
        payload: { organisationId: "org_salon", agentRunId: "run_1" },
      }),
    );
    mocks.agentRunFindFirst.mockResolvedValue({ status: "FAILED", _count: { steps: 2 } });

    const res = await retry();

    expect(res.status).toBe(409);
    expect(mocks.enqueueAgentRunJob).not.toHaveBeenCalled();
    expect(mocks.failedJobUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps the job open when the queue is unavailable", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(
      job({ queue: "agent-runs", jobName: "noop", payload: { organisationId: "org_salon" } }),
    );
    mocks.enqueueAgentRunJob.mockRejectedValue(new Error("Redis is required and unavailable"));

    const res = await retry();
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toMatch(/Couldn't re-queue/);
    expect(mocks.failedJobUpdateMany).not.toHaveBeenCalled();
  });

  it("treats an already-resolved job as done", async () => {
    mocks.failedJobFindUnique.mockResolvedValue(job({ resolvedAt: new Date() }));

    const res = await retry();
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, duplicate: true });
    expect(mocks.followUpFindFirst).not.toHaveBeenCalled();
  });
});
