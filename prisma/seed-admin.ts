import { hash } from "bcryptjs";
import { MemberRole, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_ADMIN_EMAIL = "1230shobhit@gmail.com";

async function writeAuditLog(input: {
  organisationId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      organisationId: input.organisationId ?? undefined,
      userId: input.userId ?? undefined,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: (input.metadata ?? {}) as object,
    },
  });
}

async function main() {
  const email = (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).toLowerCase().trim();
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  const mustChangePassword = process.env.ADMIN_FORCE_PASSWORD_CHANGE !== "false";

  if (!initialPassword) {
    throw new Error("ADMIN_INITIAL_PASSWORD is required to seed the super admin");
  }

  const passwordHash = await hash(initialPassword, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      isPlatformAdmin: true,
      emailVerified: new Date(),
      isActive: true,
      isSuspended: false,
      mustChangePassword,
      failedLoginAttempts: 0,
      lockedUntil: null,
      deletedAt: null,
    },
    create: {
      email,
      name: "Platform Super Admin",
      passwordHash,
      isPlatformAdmin: true,
      emailVerified: new Date(),
      isActive: true,
      isSuspended: false,
      mustChangePassword,
    },
  });

  await writeAuditLog({
    userId: user.id,
    action: existing ? "admin.seed.updated" : "admin.seed.created",
    entityType: "User",
    entityId: user.id,
    metadata: { email, isPlatformAdmin: true },
  });

  const superAdminRole =
    (MemberRole as Record<string, MemberRole>).SUPER_ADMIN ?? MemberRole.OWNER;

  const demoAgency = await prisma.organisation.findUnique({ where: { slug: "demo-agency" } });

  // Prefer SUPER_ADMIN on demo-agency when present; otherwise create platform org.
  const primaryOrg =
    demoAgency ??
    (await prisma.organisation.upsert({
      where: { slug: "dm-intelligence-platform" },
      update: {},
      create: {
        name: "DM Intelligence Platform",
        slug: "dm-intelligence-platform",
        timezone: "UTC",
        demoData: false,
      },
    }));

  await prisma.organisationMember.upsert({
    where: {
      organisationId_userId: {
        organisationId: primaryOrg.id,
        userId: user.id,
      },
    },
    update: { role: superAdminRole },
    create: {
      organisationId: primaryOrg.id,
      userId: user.id,
      role: superAdminRole,
    },
  });

  // Also ensure OWNER on demo-agency when it exists and is not the SUPER_ADMIN home
  // (unique membership — if primary is already demo-agency with SUPER_ADMIN, skip duplicate OWNER).
  if (demoAgency && demoAgency.id !== primaryOrg.id) {
    await prisma.organisationMember.upsert({
      where: {
        organisationId_userId: {
          organisationId: demoAgency.id,
          userId: user.id,
        },
      },
      update: { role: MemberRole.OWNER },
      create: {
        organisationId: demoAgency.id,
        userId: user.id,
        role: MemberRole.OWNER,
      },
    });
  }

  // When primary is demo-agency, also ensure platform org exists with SUPER_ADMIN for platform ops
  if (demoAgency && primaryOrg.id === demoAgency.id) {
    const platformOrg = await prisma.organisation.upsert({
      where: { slug: "dm-intelligence-platform" },
      update: {},
      create: {
        name: "DM Intelligence Platform",
        slug: "dm-intelligence-platform",
        timezone: "UTC",
        demoData: false,
      },
    });
    await prisma.organisationMember.upsert({
      where: {
        organisationId_userId: {
          organisationId: platformOrg.id,
          userId: user.id,
        },
      },
      update: { role: superAdminRole },
      create: {
        organisationId: platformOrg.id,
        userId: user.id,
        role: superAdminRole,
      },
    });
  }

  console.log(`Super admin ready: ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Admin seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
