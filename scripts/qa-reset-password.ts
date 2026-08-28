/** Reset local QA admin password for visual acceptance. */
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || "AcceptQA-2026-ux!";

async function main() {
  const passwordHash = await hash(PASSWORD, 12);
  const user = await prisma.user.update({
    where: { email: "1230shobhit@gmail.com" },
    data: {
      passwordHash,
      mustChangePassword: false,
      isActive: true,
      isSuspended: false,
    },
  });
  console.log(`Updated password for ${user.email}; mustChangePassword=false`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
