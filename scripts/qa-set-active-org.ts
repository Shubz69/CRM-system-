import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organisation.findFirst({
    where: { name: { contains: "Shobhit Agency QA" } },
  });
  const user = await prisma.user.findUnique({ where: { email: "1230shobhit@gmail.com" } });
  if (!org || !user) throw new Error("missing org/user");
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
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
