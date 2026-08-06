import { seedSuperAdmin } from "@/services/seed-admin";

async function main() {
  const result = await seedSuperAdmin();
  // Never log the password.
  console.log(`Super admin ready: ${result.email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Admin seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
