/**
 * Development-only schema bootstrap for an empty local database.
 *
 * NEVER use against production. Production / hosted DBs must use:
 *   npx prisma migrate deploy
 */
import { spawnSync } from "child_process";
import { PrismaClient } from "@prisma/client";

function fail(message: string): never {
  console.error(`\n[db:setup] REFUSED: ${message}\n`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    fail("NODE_ENV=production. Use `npx prisma migrate deploy` instead of db:setup.");
  }

  if (process.env.APP_RUNTIME_MODE === "production") {
    fail("APP_RUNTIME_MODE=production. Refusing db:setup against production.");
  }

  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set.");
  }

  const prisma = new PrismaClient();
  try {
    const orgCount = await prisma.organisation.count().catch(() => 0);
    if (orgCount > 0) {
      fail(
        `Target database already has ${orgCount} organisation(s). ` +
          "Use `npx prisma migrate deploy` for existing databases.",
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  console.log("[db:setup] Development bootstrap — running prisma migrate deploy + seed…");
  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: true,
  });
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);

  const seed = spawnSync("npx", ["tsx", "prisma/seed.ts"], { stdio: "inherit", shell: true });
  if (seed.status !== 0) process.exit(seed.status ?? 1);

  console.log("[db:setup] Done. For production schema changes use: npx prisma migrate deploy");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
