/**
 * Starts an embedded PostgreSQL instance for local development when Docker
 * is unavailable. Persists data under .data/pg.
 *
 * These packages are intentionally NOT in package.json (they break Vercel/Linux
 * installs when the Windows binary is declared). Install locally when needed:
 *
 *   npm install -D embedded-postgres @embedded-postgres/linux-x64
 *   # Windows: npm install -D embedded-postgres @embedded-postgres/windows-x64
 *
 * Usage: npx tsx scripts/dev-db.ts
 */
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

async function main() {
  let EmbeddedPostgres: typeof import("embedded-postgres").default;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch {
    console.error(
      [
        "embedded-postgres is not installed.",
        "Install platform packages locally (not required for Vercel):",
        "  npm install -D embedded-postgres @embedded-postgres/linux-x64",
        "  # Windows: npm install -D embedded-postgres @embedded-postgres/windows-x64",
        "Or use Docker: docker compose up -d",
      ].join("\n"),
    );
    process.exit(1);
  }

  const dataDir = join(process.cwd(), ".data", "pg");
  mkdirSync(dataDir, { recursive: true });

  const port = Number(process.env.DEV_PG_PORT || 54329);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "dmintel",
    password: "dmintel",
    port,
    persistent: true,
  });

  const alreadyInitialised = existsSync(join(dataDir, "PG_VERSION"));
  if (!alreadyInitialised) {
    console.log(`Initialising embedded Postgres in ${dataDir} on port ${port}...`);
    await pg.initialise();
  } else {
    console.log(`Starting existing Postgres cluster in ${dataDir} on port ${port}...`);
  }

  await pg.start();
  try {
    await pg.createDatabase("dm_intelligence_crm");
  } catch {
    // Database may already exist on subsequent runs
  }

  const url = `postgresql://dmintel:dmintel@127.0.0.1:${port}/dm_intelligence_crm?schema=public`;
  console.log("Embedded Postgres is running.");
  console.log(`DATABASE_URL=${url}`);
  console.log("Keep this process running while you develop.");
  console.log("In another terminal: npm run db:push && npm run db:seed && npm run dev");

  const shutdown = async () => {
    console.log("Stopping embedded Postgres...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
