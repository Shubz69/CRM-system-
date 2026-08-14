/**
 * Create a real tenant organisation and attach an owner as the sole member.
 *
 * Usage:
 *   npx tsx scripts/create-organisation.ts --name "Acme Agency" --slug acme-agency --owner-email you@example.com
 *
 * Optional:
 *   --timezone Europe/London
 *
 * Platform admins can also create workspaces in Admin → Workspaces (pass owner email there).
 */
import { MemberRole, OrganisationStatus } from "@prisma/client";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function usage(): never {
  console.error(
    `Usage: npx tsx scripts/create-organisation.ts --name "Acme Agency" --slug acme-agency --owner-email you@example.com [--timezone UTC]`,
  );
  process.exit(1);
}

async function main() {
  const name = arg("name");
  const slug = arg("slug")?.toLowerCase();
  const ownerEmail = arg("owner-email")?.toLowerCase().trim();
  const timezone = arg("timezone") || "UTC";

  if (!name || !slug || !ownerEmail) usage();
  if (!/^[a-z0-9-]+$/.test(slug!)) {
    console.error("Slug must be lowercase alphanumeric with hyphens.");
    process.exit(1);
  }

  const existing = await prisma.organisation.findUnique({ where: { slug: slug! } });
  if (existing) {
    console.error(`Slug already in use: ${slug}`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email: ownerEmail! } });
  if (!user) {
    console.error(
      `No user with email ${ownerEmail}. Seed the admin first (npm run seed:admin) or create the account.`,
    );
    process.exit(1);
  }

  const org = await prisma.organisation.create({
    data: {
      name: name!,
      slug: slug!,
      timezone,
      status: OrganisationStatus.ACTIVE,
      demoData: false,
      isPlatform: false,
      autopilotMode: "OFF",
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
        },
      },
      members: {
        create: {
          userId: user.id,
          role: MemberRole.OWNER,
        },
      },
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { activeOrganisationId: org.id },
  });

  console.log(
    JSON.stringify(
      {
        organisationId: org.id,
        name: org.name,
        slug: org.slug,
        ownerEmail: user.email,
        activeWorkspaceSet: true,
      },
      null,
      2,
    ),
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
