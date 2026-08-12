import { prisma } from "@/lib/db";

/** Sentinel org for platform-level rows that are not tenant-specific (admin settings, worker crashes). */
export const PLATFORM_ORG_SLUG = "dm-intelligence-platform";

/**
 * Returns the platform organisation id, creating it if missing.
 * Used when a ledger row must be org-scoped but the event is not tenant-owned.
 */
export async function getPlatformOrganisationId(): Promise<string> {
  const existing = await prisma.organisation.findUnique({
    where: { slug: PLATFORM_ORG_SLUG },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.organisation.upsert({
    where: { slug: PLATFORM_ORG_SLUG },
    update: {},
    create: {
      name: "DM Intelligence Platform",
      slug: PLATFORM_ORG_SLUG,
      timezone: "UTC",
      demoData: false,
    },
    select: { id: true },
  });
  return created.id;
}
