/**
 * Phase 8C — run full Vitest suite against isolated local Postgres.
 * Never touches production / shared Supabase.
 *
 * Usage: node scripts/run-unit-local-db.mjs
 * Override: TEST_DATABASE_URL=postgresql://... node scripts/run-unit-local-db.mjs
 */
import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv();

const LOCAL_DEFAULT =
  process.env.TEST_DATABASE_URL ||
  "postgresql://meridian:meridian@127.0.0.1:5432/agentdesk_test";

function looksLikeSharedProd(url) {
  const u = (url || "").toLowerCase();
  return (
    u.includes("supabase.co") ||
    u.includes("pooler.supabase") ||
    u.includes("amazonaws.com") ||
    u.includes("neon.tech") ||
    u.includes("railway.app") ||
    /[?&]pgbouncer=true/.test(u)
  );
}

if (looksLikeSharedProd(LOCAL_DEFAULT)) {
  console.error("REFUSING: TEST_DATABASE_URL looks like shared/prod pooler.");
  process.exit(2);
}

console.log("TEST_DB_STRATEGY=local_postgres_isolated");
console.log("PROD_DB_TOUCHED_BY_TESTS=NO");
console.log("DATABASE_URL=", LOCAL_DEFAULT.replace(/:[^:@/]+@/, ":***@"));

const child = spawn("npx", ["vitest", "run"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: LOCAL_DEFAULT,
    DIRECT_URL: LOCAL_DEFAULT,
    // Keep Redis local if present; tests that need Redis use localhost.
  },
});

child.on("exit", (code) => process.exit(code ?? 1));
