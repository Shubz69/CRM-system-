/**
 * DB integration — AuditLog CHECK + platform-org delete trigger.
 * Separate file so unit mocks of @/lib/db cannot poison these tests.
 *
 * Skipped only when DATABASE_URL is unset.
 * If DATABASE_URL is set but unreachable, beforeAll fails loudly (not a silent skip).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { tenantAuditLogWhere } from "@/services/audit";
import { getPlatformOrganisationId } from "@/lib/platform-org";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("AuditLog scope — DB CHECK constraint (needs Postgres)", () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects ORG-scoped row with null organisationId", async () => {
    await expect(
      prisma.auditLog.create({
        data: {
          scope: "ORG",
          organisationId: null,
          action: "test.org_null_org",
        },
      }),
    ).rejects.toThrow(/AuditLog_scope_organisation_check|check constraint/i);
  });

  it("rejects PLATFORM-scoped row with non-null organisationId", async () => {
    const org = await prisma.organisation.create({
      data: { name: "Check Org", slug: `check-${Date.now()}` },
    });

    await expect(
      prisma.auditLog.create({
        data: {
          scope: "PLATFORM",
          organisationId: org.id,
          action: "test.platform_with_org",
        },
      }),
    ).rejects.toThrow(/AuditLog_scope_organisation_check|check constraint/i);

    await prisma.organisation.delete({ where: { id: org.id } });
  });

  it("tenant query never returns PLATFORM rows even if they exist", async () => {
    const org = await prisma.organisation.create({
      data: { name: "Tenant Q", slug: `tq-${Date.now()}` },
    });

    const orgLog = await prisma.auditLog.create({
      data: {
        scope: "ORG",
        organisationId: org.id,
        action: "test.tenant_visible",
      },
    });
    const platformLog = await prisma.auditLog.create({
      data: {
        scope: "PLATFORM",
        organisationId: null,
        action: "test.platform_hidden",
      },
    });

    const rows = await prisma.auditLog.findMany({
      where: tenantAuditLogWhere(org.id),
    });

    expect(rows.map((r) => r.id)).toContain(orgLog.id);
    expect(rows.map((r) => r.id)).not.toContain(platformLog.id);
    expect(rows.every((r) => r.scope === "ORG")).toBe(true);

    await prisma.auditLog.deleteMany({ where: { id: { in: [orgLog.id, platformLog.id] } } });
    await prisma.organisation.delete({ where: { id: org.id } });
  });

  it("refuses to hard-delete the platform organisation (DB trigger)", async () => {
    const id = await getPlatformOrganisationId();
    await expect(prisma.organisation.delete({ where: { id } })).rejects.toThrow(
      /platform organisation/i,
    );
  });

  it("RESTRICT blocks hard-delete while ORG audit rows exist", async () => {
    const org = await prisma.organisation.create({
      data: { name: "Restrict Org", slug: `restrict-${Date.now()}` },
    });
    await prisma.auditLog.create({
      data: {
        scope: "ORG",
        organisationId: org.id,
        action: "test.restrict_blocks_delete",
      },
    });

    await expect(prisma.organisation.delete({ where: { id: org.id } })).rejects.toThrow(
      /Foreign key constraint|Restrict|restrict/i,
    );

    await prisma.auditLog.deleteMany({ where: { organisationId: org.id } });
    await prisma.organisation.delete({ where: { id: org.id } });
  });
});
