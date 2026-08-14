import { hash } from "bcryptjs";
import { MemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import { getPlatformOrganisationId, PLATFORM_ORG_SLUG } from "@/lib/platform-org";

const DEFAULT_ADMIN_EMAIL = "1230shobhit@gmail.com";

export type SeedAdminResult = {
  email: string;
  created: boolean;
  updated: boolean;
  organisationIds: string[];
};

/**
 * Idempotent super-admin seed. Hashes ADMIN_INITIAL_PASSWORD; never returns it.
 * Attaches the admin to the platform organisation only — tenant orgs are created
 * via Admin → Workspaces or scripts/create-organisation.ts.
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

  const platformOrgId = await getPlatformOrganisationId();
  await prisma.organisation.update({
    where: { id: platformOrgId },
    data: { name: "Agent Desk Platform", isPlatform: true, demoData: false },
  });

  await prisma.organisationMember.upsert({
    where: {
      organisationId_userId: {
        organisationId: platformOrgId,
        userId: user.id,
      },
    },
    update: { role: superAdminRole },
    create: {
      organisationId: platformOrgId,
      userId: user.id,
      role: superAdminRole,
    },
  });

  // Prefer an existing non-platform active workspace; otherwise stay on platform.
  const tenantMembership = await prisma.organisationMember.findFirst({
    where: {
      userId: user.id,
      organisation: { isPlatform: false, deletedAt: null, status: "ACTIVE" },
    },
    orderBy: { createdAt: "asc" },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      activeOrganisationId: tenantMembership?.organisationId ?? platformOrgId,
    },
  });

  return {
    email,
    created: !existing,
    updated: Boolean(existing),
    organisationIds: [platformOrgId],
  };
}

export { PLATFORM_ORG_SLUG };
