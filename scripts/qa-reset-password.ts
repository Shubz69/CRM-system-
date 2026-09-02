/** Reset a QA user password. Requires env — never hard-code credentials. */
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EMAIL = (process.env.E2E_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || process.env.E2E_PASSWORD || "";

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("Set E2E_EMAIL (or ADMIN_EMAIL) and ADMIN_INITIAL_PASSWORD (or E2E_PASSWORD)");
  }
  const passwordHash = await hash(PASSWORD, 12);
  const user = await prisma.user.update({
    where: { email: EMAIL },
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
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
