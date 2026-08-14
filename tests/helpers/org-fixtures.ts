/**
 * Ephemeral organisation fixtures for DB integration tests.
 * Never rely on seeded application data (demo-agency, etc.).
 */
import { prisma } from "@/lib/db";
import { purgeOrganisationHard } from "@/services/organisation-lifecycle";

export type TestOrganisationFixture = {
  organisationId: string;
  slug: string;
};

/** Create an ACTIVE org with default pipeline stages + agent config. */
export async function createTestOrganisation(label = "test"): Promise<TestOrganisationFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = `${label}-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const org = await prisma.organisation.create({
    data: {
      name: `Test ${label} ${stamp}`,
      slug,
      status: "ACTIVE",
      demoData: false,
      isPlatform: false,
      autopilotMode: "LIVE",
      pipelines: {
        create: {
          name: "Default",
          isDefault: true,
          stages: {
            create: [
              { name: "New", slug: "new", position: 0 },
              { name: "Contacted", slug: "contacted", position: 1 },
              { name: "Engaged", slug: "engaged", position: 2 },
              { name: "Qualifying", slug: "qualifying", position: 3 },
              { name: "Qualified", slug: "qualified", position: 4 },
              { name: "Booking Link Sent", slug: "booking_offered", position: 5 },
              { name: "Booked", slug: "booked", position: 6 },
              { name: "Won", slug: "won", position: 7, isWon: true },
              { name: "Disqualified", slug: "disqualified", position: 8, isLost: true },
            ],
          },
        },
      },
      agentConfigurations: {
        create: {
          name: "Default Agent",
          isActive: true,
          isDraft: false,
          brandTone: "professional, helpful, concise",
          aiProvider: "mock",
          model: "mock",
        },
      },
    },
  });

  return { organisationId: org.id, slug: org.slug };
}

/** Tear down fixture org including RESTRICT ledger rows. */
export async function destroyTestOrganisation(fixture: TestOrganisationFixture): Promise<void> {
  try {
    await purgeOrganisationHard({
      organisationId: fixture.organisationId,
      confirmSlug: fixture.slug,
    });
  } catch {
    // Soft-fallback if purge fails (e.g. already deleted): best-effort cleanup.
    await prisma.organisation.delete({ where: { id: fixture.organisationId } }).catch(() => undefined);
  }
}
