import { prisma } from "@/lib/db";

/** Sentinel org for platform-level ledger rows that are not tenant-specific. */
export const PLATFORM_ORG_SLUG = "dm-intelligence-platform";

/**
 * Returns the platform organisation id, creating it if missing.
 * Used for WebhookEvent / FailedJob / UsageRecord / AiExecution orphans —
 * NOT for AuditLog (those use scope=PLATFORM with null organisationId).
 */
export async function getPlatformOrganisationId(): Promise<string> {
  const existing = await prisma.organisation.findUnique({
    where: { slug: PLATFORM_ORG_SLUG },
    select: { id: true, isPlatform: true },
  });
  if (existing) {
    if (!existing.isPlatform) {
      await prisma.organisation.update({
        where: { id: existing.id },
        data: { isPlatform: true, name: "Agent Desk Platform" },
      });
    }
    return existing.id;
  }

  const created = await prisma.organisation.upsert({
    where: { slug: PLATFORM_ORG_SLUG },
    update: { isPlatform: true, name: "Agent Desk Platform" },
    create: {
      name: "Agent Desk Platform",
      slug: PLATFORM_ORG_SLUG,
      timezone: "UTC",
      demoData: false,
      isPlatform: true,
    },
    select: { id: true },
  });
  return created.id;
}

/** Throws if the organisation is the protected platform org. */
export async function assertOrganisationMutable(organisationId: string): Promise<void> {
  const org = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: { id: true, isPlatform: true, slug: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.isPlatform) {
    throw new Error(
      `Organisation "${org.slug}" is the platform org and cannot be deleted, suspended, or soft-deleted`,
    );
  }
}
