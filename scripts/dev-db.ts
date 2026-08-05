/**
 * Starts an embedded PostgreSQL instance for local development when Docker
 * is unavailable. Persists data under .data/pg.
 *
 * Usage: npx tsx scripts/dev-db.ts
 */
import { mkdirSync } from "fs";
import { join } from "path";
import EmbeddedPostgres from "embedded-postgres";

async function main() {
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

  console.log(`Initialising embedded Postgres in ${dataDir} on port ${port}...`);
  await pg.initialise();
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
