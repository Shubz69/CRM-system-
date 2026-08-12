import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "log_1",
    ...args.data,
  }));
  const findMany = vi.fn(async () => []);
  return {
    prisma: {
      auditLog: { create, findMany },
      __mocks: { create, findMany },
    },
  };
});

import { prisma } from "@/lib/db";
import { tenantAuditLogWhere, writeAuditLog } from "@/services/audit";

type Mocks = {
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("AuditLog scope — writeAuditLog (unit)", () => {
  beforeEach(() => {
    mocks.create.mockClear();
  });

  it("writes ORG scope with organisationId by default", async () => {
    await writeAuditLog({
      organisationId: "org_a",
      action: "booking.created",
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "ORG",
          organisationId: "org_a",
          action: "booking.created",
        }),
      }),
    );
  });

  it("writes PLATFORM scope with null organisationId", async () => {
    await writeAuditLog({
      scope: "PLATFORM",
      action: "auth.password_reset_requested",
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "PLATFORM",
          organisationId: null,
        }),
      }),
    );
  });

  it("rejects ORG writes without organisationId", async () => {
    await expect(
      // @ts-expect-error intentional invalid call
      writeAuditLog({ action: "bad.org" }),
    ).rejects.toThrow(/organisationId/);
  });

  it("rejects PLATFORM writes that include organisationId", async () => {
    await expect(
      writeAuditLog({
        scope: "PLATFORM",
        organisationId: "org_should_not_be_here",
        action: "system.setting_updated",
      } as never),
    ).rejects.toThrow(/must not set organisationId/);
  });
});

describe("AuditLog scope — tenant query filter (unit)", () => {
  it("tenantAuditLogWhere always includes scope ORG", () => {
    expect(tenantAuditLogWhere("org_a")).toEqual({
      scope: "ORG",
      organisationId: "org_a",
    });
  });

  it("tenant AuditLog query never returns PLATFORM rows", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { id: "1", scope: "ORG", organisationId: "org_a", action: "booking.created" },
    ]);

    const where = tenantAuditLogWhere("org_a");
    const rows = await prisma.auditLog.findMany({ where });

    expect(mocks.findMany).toHaveBeenCalledWith({ where });
    expect(where.scope).toBe("ORG");
    expect(rows.every((r: { scope: string }) => r.scope === "ORG")).toBe(true);
    expect(rows.some((r: { scope: string }) => r.scope === "PLATFORM")).toBe(false);
  });
});
