/**
 * One-shot: remove demo-agency / northstar / demoData orgs and the demo user.
 * Keeps dm-intelligence-platform (isPlatform).
 *
 *   npx tsx scripts/purge-demo-data.ts
 */
import { prisma } from "../src/lib/db";
import { purgeOrganisationHard } from "../src/services/organisation-lifecycle";

const DEMO_EMAIL = "demo@dminelligence.local";
const KEEP_SLUGS = new Set(["dm-intelligence-platform"]);

async function main() {
  const candidates = await prisma.organisation.findMany({
    where: {
      OR: [
        { slug: { in: ["demo-agency", "northstar-studio"] } },
        { demoData: true },
      ],
      isPlatform: false,
    },
    select: { id: true, slug: true, name: true },
  });

  const purgeIds = candidates.filter((o) => !KEEP_SLUGS.has(o.slug)).map((o) => o.id);

  if (purgeIds.length) {
    await prisma.user.updateMany({
      where: { activeOrganisationId: { in: purgeIds } },
      data: { activeOrganisationId: null },
    });
  }

  const demoUser = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (demoUser) {
    await prisma.session.deleteMany({ where: { userId: demoUser.id } }).catch(() => undefined);
    await prisma.account.deleteMany({ where: { userId: demoUser.id } }).catch(() => undefined);
    await prisma.organisationMember.deleteMany({ where: { userId: demoUser.id } });
    await prisma.user.delete({ where: { id: demoUser.id } });
    console.log(`Deleted demo user: ${DEMO_EMAIL}`);
  } else {
    console.log("Demo user not present");
  }

  for (const org of candidates) {
    if (KEEP_SLUGS.has(org.slug)) continue;
    await purgeOrganisationHard({
      organisationId: org.id,
      confirmSlug: org.slug,
    });
    console.log(`Purged organisation: ${org.slug} (${org.name})`);
  }

  if (!candidates.length) {
    console.log("No demo organisations found");
  }

  const platform = await prisma.organisation.findUnique({
    where: { slug: "dm-intelligence-platform" },
  });
  console.log(
    platform
      ? `Platform org retained: ${platform.slug}`
      : "WARNING: platform org missing — run npm run db:seed",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
