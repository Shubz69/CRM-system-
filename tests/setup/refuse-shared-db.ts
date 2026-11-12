/**
 * Vitest global setup — refuse to run against the shared / production database.
 *
 * The DB suites create and hard-purge throw-away organisations (~40 per full run).
 * Pointed at the production Supabase (via the local `.env`), every `npm test` added
 * and deleted dozens of Organisation rows (thousands of `DELETE FROM "Organisation"`),
 * contended with the live workers, and leaked fixture orgs ("Ret A", "Ret B", …) that
 * background sweeps then processed.
 *
 * Use `npm run test:local` (isolated local Postgres), or set
 * ALLOW_SHARED_DB_TESTS=true to override deliberately.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";

function looksLikeSharedDatabase(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("supabase.co") ||
    u.includes("supabase.com") ||
    u.includes("pooler.supabase") ||
    u.includes("amazonaws.com") ||
    u.includes("neon.tech") ||
    u.includes("railway.app") ||
    u.includes("rlwy.net") ||
    /[?&]pgbouncer=true/.test(u)
  );
}

function effectiveDatabaseUrl(): string {
  // Same resolution Prisma uses: process env first, then the project .env.
  // Parsed read-only so the test environment is not changed.
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return "";
  return parseEnv(fs.readFileSync(envPath)).DATABASE_URL || "";
}

export default function setup() {
  const url = effectiveDatabaseUrl();
  if (!url || !looksLikeSharedDatabase(url)) return;
  if (process.env.ALLOW_SHARED_DB_TESTS === "true") {
    console.warn("[tests] ALLOW_SHARED_DB_TESTS=true — running against a shared database.");
    return;
  }
  throw new Error(
    "Refusing to run tests: DATABASE_URL points at a shared/production database. " +
      "Use `npm run test:local` (local Postgres) or set ALLOW_SHARED_DB_TESTS=true deliberately.",
  );
}
