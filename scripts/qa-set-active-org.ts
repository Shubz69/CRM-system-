import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.E2E_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const orgName = process.env.E2E_WORKSPACE_NAME || "";
  if (!email) throw new Error("Set E2E_EMAIL or ADMIN_EMAIL");
  if (!orgName) throw new Error("Set E2E_WORKSPACE_NAME to the workspace display name fragment");

  const org = await prisma.organisation.findFirst({
    where: { name: { contains: orgName } },
  });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!org || !user) throw new Error("missing org/user for provided env");
  await prisma.user.update({
    where: { id: user.id },
    data: { activeOrganisationId: org.id },
  });
  const conversations = await prisma.conversation.count({
    where: { organisationId: org.id, deletedAt: null },
  });
  console.log(JSON.stringify({ orgId: org.id, conversations }, null, 2));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
