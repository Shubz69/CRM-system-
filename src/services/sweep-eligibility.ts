import type { Prisma } from "@prisma/client";

/**
 * Which organisations the background Postgres sweeps (opportunity detectors,
 * continuous intelligence, daily insights, process twin) should visit.
 *
 * Requires at least one member: the DB integration test fixtures
 * (tests/helpers/org-fixtures.ts and the `*.db.test.ts` suites) create member-less
 * ACTIVE orgs, and when those suites run against the shared database they crowd
 * the `take: 50` sweep window (newest first) and leak orgs that were swept forever.
 */
export function sweepEligibleOrganisationWhere(): Prisma.OrganisationWhereInput {
  return {
    status: "ACTIVE",
    deletedAt: null,
    isPlatform: false,
    members: { some: {} },
  };
}
