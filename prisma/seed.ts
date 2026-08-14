/**
 * Bootstrap seed — platform organisation only.
 * Tenant workspaces are created via Admin → Workspaces or:
 *   npx tsx scripts/create-organisation.ts --name "…" --slug … --owner-email …
 */
import { prisma } from "../src/lib/db";
import { PLATFORM_ORG_SLUG } from "../src/lib/platform-org";

async function main() {
  const platform = await prisma.organisation.upsert({
    where: { slug: PLATFORM_ORG_SLUG },
    update: {
      name: "Agent Desk Platform",
      isPlatform: true,
      demoData: false,
      deletedAt: null,
      status: "ACTIVE",
    },
    create: {
      name: "Agent Desk Platform",
      slug: PLATFORM_ORG_SLUG,
      timezone: "UTC",
      demoData: false,
      isPlatform: true,
      status: "ACTIVE",
    },
  });

  console.log(`Platform organisation ready: ${platform.slug} (${platform.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
