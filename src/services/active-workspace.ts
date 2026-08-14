import type { MemberRole, Organisation, OrganisationMember } from "@prisma/client";
import { prisma } from "@/lib/db";

export type ActiveWorkspaceMembership = OrganisationMember & {
  organisation: Organisation;
};

export type SessionMembershipLite = {
  organisationId: string;
  organisationName: string;
  role: MemberRole;
  isPlatform: boolean;
};

/**
 * Choose which workspace a multi-membership user is scoped to.
 *
 * Priority:
 * 1. Explicit preferredOrganisationId when the user is still a member
 *    (activeOrganisationId on User, or a switcher selection)
 * 2. First non-platform tenant workspace (day-to-day product use)
 * 3. Otherwise the first remaining membership (e.g. platform-only admins)
 *
 * Never silently prefers SUPER_ADMIN on the platform sentinel org — that made
 * multi-membership sessions ambiguous and could strand a JWT on the wrong id.
 */
export function pickActiveWorkspace<
  T extends {
    organisationId: string;
    role: MemberRole;
    organisation: { id: string; name: string; isPlatform: boolean; deletedAt: Date | null; status: string };
  },
>(memberships: T[], preferredOrganisationId?: string | null): T | null {
  const usable = memberships.filter(
    (m) => !m.organisation.deletedAt && m.organisation.status === "ACTIVE",
  );
  if (!usable.length) return null;

  if (preferredOrganisationId) {
    const preferred = usable.find((m) => m.organisationId === preferredOrganisationId);
    if (preferred) return preferred;
  }

  const tenant = usable.find((m) => !m.organisation.isPlatform);
  return tenant ?? usable[0] ?? null;
}

export async function loadUserWorkspaceMemberships(userId: string) {
  return prisma.organisationMember.findMany({
    where: { userId },
    include: { organisation: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function resolveActiveWorkspaceForUser(input: {
  userId: string;
  preferredOrganisationId?: string | null;
  /** When true, write the resolved id back to User.activeOrganisationId. */
  persist?: boolean;
}): Promise<{
  membership: ActiveWorkspaceMembership;
  memberships: SessionMembershipLite[];
} | null> {
  const rows = await loadUserWorkspaceMemberships(input.userId);
  const picked = pickActiveWorkspace(rows, input.preferredOrganisationId);
  if (!picked) return null;

  if (input.persist) {
    await prisma.user.update({
      where: { id: input.userId },
      data: { activeOrganisationId: picked.organisationId },
    });
  }

  return {
    membership: picked,
    memberships: rows
      .filter((m) => !m.organisation.deletedAt)
      .map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        role: m.role,
        isPlatform: m.organisation.isPlatform,
      })),
  };
}
