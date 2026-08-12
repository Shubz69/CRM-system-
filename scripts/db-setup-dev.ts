/**
 * Development-only schema bootstrap.
 *
 * NEVER use against production or any database that already has tenant data.
 * Production / populated DBs must use: npx prisma migrate deploy
 */
import { spawnSync } from "child_process";
import { PrismaClient } from "@prisma/client";

function fail(message: string): never {
  console.error(`\n[db:setup] REFUSED: ${message}\n`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    fail(
      "NODE_ENV=production. Use `npx prisma migrate deploy` instead of db:setup / db push.",
    );
  }

  if (process.env.APP_RUNTIME_MODE === "production") {
    fail("APP_RUNTIME_MODE=production. Refusing destructive db push.");
  }

  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set.");
  }

  const allowPush = process.env.ALLOW_DB_PUSH === "true";
  const prisma = new PrismaClient();
  try {
    const orgCount = await prisma.organisation.count().catch(() => 0);
    if (orgCount > 0 && !allowPush) {
      fail(
        `Target database already has ${orgCount} organisation(s). ` +
          "`prisma db push` can destroy data. Use \`npx prisma migrate deploy\` for existing databases, " +
          "or set ALLOW_DB_PUSH=true only for disposable local DBs.",
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  console.log("[db:setup] Development bootstrap — running prisma db push + seed…");
  const push = spawnSync("npx", ["prisma", "db", "push"], { stdio: "inherit", shell: true });
  if (push.status !== 0) process.exit(push.status ?? 1);

  const seed = spawnSync("npx", ["tsx", "prisma/seed.ts"], { stdio: "inherit", shell: true });
  if (seed.status !== 0) process.exit(seed.status ?? 1);

  console.log("[db:setup] Done. For production schema changes use: npx prisma migrate deploy");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
