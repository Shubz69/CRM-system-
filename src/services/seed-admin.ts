import { hash } from "bcryptjs";
import { MemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";

const DEFAULT_ADMIN_EMAIL = "1230shobhit@gmail.com";

export type SeedAdminResult = {
  email: string;
  created: boolean;
  updated: boolean;
  organisationIds: string[];
};

/**
 * Idempotent super-admin seed. Hashes ADMIN_INITIAL_PASSWORD; never returns it.
 */
export async function seedSuperAdmin(input?: {
  email?: string;
  initialPassword?: string;
  forcePasswordChange?: boolean;
}): Promise<SeedAdminResult> {
  const email = (input?.email || process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL)
    .toLowerCase()
    .trim();
  const initialPassword = input?.initialPassword || process.env.ADMIN_INITIAL_PASSWORD;
  const mustChangePassword =
    input?.forcePasswordChange ?? process.env.ADMIN_FORCE_PASSWORD_CHANGE !== "false";

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
    scope: "PLATFORM",
    userId: user.id,
    action: existing ? "admin.seed.updated" : "admin.seed.created",
    entityType: "User",
    entityId: user.id,
    metadata: { email, isPlatformAdmin: true },
  });

  const superAdminRole =
    (MemberRole as Record<string, MemberRole>).SUPER_ADMIN ?? MemberRole.OWNER;

  const demoAgency = await prisma.organisation.findUnique({ where: { slug: "demo-agency" } });

  const primaryOrg =
    demoAgency ??
    (await prisma.organisation.upsert({
      where: { slug: "dm-intelligence-platform" },
      update: { isPlatform: true },
      create: {
        name: "Agent Desk Platform",
        slug: "dm-intelligence-platform",
        timezone: "UTC",
        demoData: false,
        isPlatform: true,
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

  const organisationIds = [primaryOrg.id];

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
    organisationIds.push(demoAgency.id);
  }

  if (demoAgency && primaryOrg.id === demoAgency.id) {
    const platformOrg = await prisma.organisation.upsert({
      where: { slug: "dm-intelligence-platform" },
      update: {},
      create: {
        name: "Agent Desk Platform",
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
    if (!organisationIds.includes(platformOrg.id)) organisationIds.push(platformOrg.id);
  }

  // Ensure at least one default pipeline so the app is usable after bootstrap.
  const existingPipeline = await prisma.pipeline.findFirst({
    where: { organisationId: primaryOrg.id, isDefault: true },
  });
  if (!existingPipeline) {
    await prisma.pipeline.create({
      data: {
        organisationId: primaryOrg.id,
        name: "Sales pipeline",
        isDefault: true,
        stages: {
          create: [
            { name: "New", slug: "new", position: 0, color: "#94a3b8" },
            { name: "Qualified", slug: "qualified", position: 1, color: "#34d399" },
            { name: "Booked", slug: "booked", position: 2, color: "#f59e0b" },
            { name: "Won", slug: "won", position: 3, color: "#22c55e", isWon: true },
            { name: "Lost", slug: "lost", position: 4, color: "#ef4444", isLost: true },
          ],
        },
      },
    });
  }

  const agent = await prisma.agentConfiguration.findFirst({
    where: { organisationId: primaryOrg.id },
  });
  if (!agent) {
    await prisma.agentConfiguration.create({
      data: {
        organisationId: primaryOrg.id,
        name: "Default agent",
        isActive: true,
        isDraft: false,
        brandTone: "professional, helpful, concise",
        aiProvider: "anthropic",
        model: process.env.ANTHROPIC_DEFAULT_MODEL || "claude-sonnet-4-20250514",
      },
    });
  }

  return {
    email,
    created: !existing,
    updated: Boolean(existing),
    organisationIds,
  };
}
