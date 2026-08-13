import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/db", () => {
  const organisation = {
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const auditLog = { count: vi.fn(), deleteMany: vi.fn(), create: vi.fn() };
  const usageRecord = { count: vi.fn(), deleteMany: vi.fn() };
  const aiExecution = { count: vi.fn(), deleteMany: vi.fn() };
  const webhookEvent = { count: vi.fn(), deleteMany: vi.fn() };
  const failedJob = { count: vi.fn(), deleteMany: vi.fn() };
  return {
    prisma: {
      organisation,
      auditLog,
      usageRecord,
      aiExecution,
      webhookEvent,
      failedJob,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          auditLog,
          usageRecord,
          aiExecution,
          webhookEvent,
          failedJob,
          organisation,
        }),
      ),
      __mocks: {
        organisation,
        auditLog,
        usageRecord,
        aiExecution,
        webhookEvent,
        failedJob,
      },
    },
  };
});

vi.mock("@/lib/platform-org", () => ({
  assertOrganisationMutable: vi.fn(async () => undefined),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import {
  exportOrganisationLedgers,
  purgeOrganisationHard,
  softDeleteOrganisation,
} from "@/services/organisation-lifecycle";

type Mocks = {
  organisation: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  auditLog: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  usageRecord: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  aiExecution: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  webhookEvent: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  failedJob: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("organisation lifecycle — soft-delete + restrict purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("softDeleteOrganisation sets deletedAt and suspends (does not hard-delete)", async () => {
    mocks.organisation.update.mockResolvedValue({
      id: "org_1",
      deletedAt: new Date("2026-08-12T00:00:00Z"),
    });

    const result = await softDeleteOrganisation({
      organisationId: "org_1",
      actorUserId: "user_1",
      reason: "churn",
    });

    expect(result.deletedAt).toBeTruthy();
    expect(mocks.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org_1" },
        data: expect.objectContaining({
          status: "SUSPENDED",
          autopilotMode: "PAUSED",
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.organisation.delete).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.soft_delete", organisationId: "org_1" }),
    );
  });

  it("purgeOrganisationHard refuses mismatched confirmSlug", async () => {
    mocks.organisation.findUnique.mockResolvedValue({
      id: "org_1",
      slug: "acme",
      name: "Acme",
    });

    await expect(
      purgeOrganisationHard({
        organisationId: "org_1",
        confirmSlug: "wrong",
      }),
    ).rejects.toThrow(/confirmSlug/);
    expect(mocks.organisation.delete).not.toHaveBeenCalled();
  });

  it("purgeOrganisationHard deletes ledgers then the organisation", async () => {
    mocks.organisation.findUnique.mockResolvedValue({
      id: "org_1",
      slug: "acme",
      name: "Acme",
    });
    for (const m of [
      mocks.auditLog,
      mocks.usageRecord,
      mocks.aiExecution,
      mocks.webhookEvent,
      mocks.failedJob,
    ]) {
      m.count.mockResolvedValue(2);
      m.deleteMany.mockResolvedValue({ count: 2 });
    }
    mocks.organisation.delete.mockResolvedValue({ id: "org_1" });

    const result = await purgeOrganisationHard({
      organisationId: "org_1",
      confirmSlug: "acme",
      actorUserId: "admin_1",
    });

    expect(result.export.counts.auditLogs).toBe(2);
    expect(mocks.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { organisationId: "org_1" },
    });
    expect(mocks.organisation.delete).toHaveBeenCalledWith({ where: { id: "org_1" } });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "PLATFORM", action: "workspace.purge_started" }),
    );
  });

  it("exportOrganisationLedgers counts all five ledger tables", async () => {
    mocks.auditLog.count.mockResolvedValue(1);
    mocks.usageRecord.count.mockResolvedValue(2);
    mocks.aiExecution.count.mockResolvedValue(3);
    mocks.webhookEvent.count.mockResolvedValue(4);
    mocks.failedJob.count.mockResolvedValue(5);

    const exported = await exportOrganisationLedgers("org_1");
    expect(exported.counts).toEqual({
      auditLogs: 1,
      usageRecords: 2,
      aiExecutions: 3,
      webhookEvents: 4,
      failedJobs: 5,
    });
  });
});

describe("ledger Restrict — schema and forward migration", () => {
  it("schema.prisma uses onDelete Restrict for ledger tables", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    for (const model of ["WebhookEvent", "AuditLog", "FailedJob", "UsageRecord", "AiExecution"]) {
      const block = schema.split(`model ${model} {`)[1]?.split("\nmodel ")[0] ?? "";
      expect(block).toMatch(/onDelete:\s*Restrict/);
      expect(block).not.toMatch(/onDelete:\s*Cascade/);
    }
  });

  it("forward migration recreates ledger FKs as ON DELETE RESTRICT", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260812160000_reconcile_drift_ledger_restrict/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toMatch(/WebhookEvent_organisationId_fkey[\s\S]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/AuditLog_organisationId_fkey[\s\S]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/FailedJob_organisationId_fkey[\s\S]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/UsageRecord_organisationId_fkey[\s\S]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/AiExecution_organisationId_fkey[\s\S]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/ContactIdentifier_organisationId_channel_identifier_key/);
    expect(sql).toMatch(/Note_organisationId_createdAt_idx/);
    expect(sql).toMatch(/Attribution_organisationId_createdAt_idx/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "FailedJob"/);
  });
});
