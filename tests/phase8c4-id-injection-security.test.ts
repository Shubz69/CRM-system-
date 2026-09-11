import { describe, expect, it, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import { asSafePrismaId, orgScopedIdWhere } from "@/lib/safe-prisma-id";

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
import { purgeOrganisationHard, softDeleteOrganisation } from "@/services/organisation-lifecycle";

type Mocks = {
  organisation: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  auditLog: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  usageRecord: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  aiExecution: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  webhookEvent: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  failedJob: { count: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

const INJECTION_PAYLOADS: unknown[] = [
  { $ne: null },
  { $gt: "" },
  ["org_1"],
  "",
  "   ",
  null,
  undefined,
  42,
  true,
  { organisationId: "org_1" },
];

describe("asSafePrismaId — reject operator / malformed payloads", () => {
  it("accepts a valid scalar id", () => {
    expect(asSafePrismaId("cmtsfsskh0000fp7wfcpghx57")).toBe("cmtsfsskh0000fp7wfcpghx57");
  });

  for (const payload of INJECTION_PAYLOADS) {
    it(`rejects ${JSON.stringify(payload)}`, () => {
      expect(() => asSafePrismaId(payload)).toThrow(ZodError);
    });
  }
});

describe("orgScopedIdWhere — research job filter shape", () => {
  it("emits equals scalars for valid ids", () => {
    expect(orgScopedIdWhere("job_1", "org_a")).toEqual({
      id: { equals: "job_1" },
      organisationId: { equals: "org_a" },
    });
  });

  it("rejects object-like job id before Prisma sees it", () => {
    expect(() => orgScopedIdWhere({ $ne: "x" }, "org_a")).toThrow(ZodError);
  });

  it("rejects operator-like organisationId", () => {
    expect(() => orgScopedIdWhere("job_1", { $ne: null })).toThrow(ZodError);
  });

  it("rejects empty / array ids", () => {
    expect(() => orgScopedIdWhere("", "org_a")).toThrow(ZodError);
    expect(() => orgScopedIdWhere("job_1", [])).toThrow(ZodError);
  });

  it("cross-org style: different org id is a different equality filter (no wildcard)", () => {
    const wrongOrg = orgScopedIdWhere("job_owned_by_b", "org_a");
    expect(wrongOrg.organisationId.equals).toBe("org_a");
    expect(wrongOrg).not.toMatchObject({ organisationId: expect.objectContaining({ $ne: expect.anything() }) });
  });
});

describe("organisation hard-purge — id injection safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of [
      mocks.auditLog,
      mocks.usageRecord,
      mocks.aiExecution,
      mocks.webhookEvent,
      mocks.failedJob,
    ]) {
      m.count.mockResolvedValue(0);
      m.deleteMany.mockResolvedValue({ count: 0 });
    }
  });

  it("valid id + matching slug uses equals filters only", async () => {
    mocks.organisation.findUnique.mockResolvedValue({
      id: "org_safe",
      slug: "safe-slug",
      name: "Safe",
    });
    mocks.organisation.delete.mockResolvedValue({ id: "org_safe" });

    await purgeOrganisationHard({
      organisationId: "org_safe",
      confirmSlug: "safe-slug",
    });

    expect(mocks.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { organisationId: { equals: "org_safe" } },
    });
    expect(mocks.organisation.delete).toHaveBeenCalledWith({
      where: { id: "org_safe" },
    });
  });

  it("rejects object-like organisationId before any delete", async () => {
    await expect(
      purgeOrganisationHard({
        organisationId: { $ne: null } as unknown as string,
        confirmSlug: "acme",
      }),
    ).rejects.toThrow(ZodError);
    expect(mocks.organisation.findUnique).not.toHaveBeenCalled();
    expect(mocks.organisation.delete).not.toHaveBeenCalled();
  });

  it("rejects empty organisationId", async () => {
    await expect(
      purgeOrganisationHard({ organisationId: "", confirmSlug: "acme" }),
    ).rejects.toThrow(ZodError);
  });

  it("rejects array organisationId", async () => {
    await expect(
      purgeOrganisationHard({
        organisationId: ["org_1"] as unknown as string,
        confirmSlug: "acme",
      }),
    ).rejects.toThrow(ZodError);
  });

  it("cross-org: cannot purge org A using org B confirmSlug", async () => {
    mocks.organisation.findUnique.mockResolvedValue({
      id: "org_a",
      slug: "org-a",
      name: "Org A",
    });
    await expect(
      purgeOrganisationHard({
        organisationId: "org_a",
        confirmSlug: "org-b",
      }),
    ).rejects.toThrow(/confirmSlug/);
    expect(mocks.organisation.delete).not.toHaveBeenCalled();
    expect(mocks.auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it("unknown organisationId does not delete", async () => {
    mocks.organisation.findUnique.mockResolvedValue(null);
    await expect(
      purgeOrganisationHard({
        organisationId: "org_missing",
        confirmSlug: "anything",
      }),
    ).rejects.toThrow(/not found/i);
    expect(mocks.organisation.delete).not.toHaveBeenCalled();
  });

  it("softDelete rejects operator payload", async () => {
    await expect(
      softDeleteOrganisation({
        organisationId: { $gt: "" } as unknown as string,
      }),
    ).rejects.toThrow(ZodError);
    expect(mocks.organisation.update).not.toHaveBeenCalled();
  });
});
