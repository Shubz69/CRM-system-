import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Normalize DATABASE_URL for serverless + Supabase poolers.
 * Session mode (port 5432 pooler) exhausts quickly under Vercel concurrency.
 * Prefer transaction pooler (6543) with pgbouncer=true&connection_limit=1.
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const isSupabasePooler = url.hostname.includes("pooler.supabase.com");
    const isSessionPort = url.port === "5432" || url.port === "";
    const hasPgBouncer = url.searchParams.get("pgbouncer") === "true";

    // Soft-correct common misconfiguration: session pooler without connection_limit.
    if (isSupabasePooler) {
      if (url.port === "6543" || hasPgBouncer) {
        url.searchParams.set("pgbouncer", "true");
        if (!url.searchParams.has("connection_limit")) {
          url.searchParams.set("connection_limit", "1");
        }
      } else if (isSessionPort && process.env.NODE_ENV === "production") {
        // Warn via stderr — do not rewrite port automatically (credentials/path differ).
        console.warn(
          "[db] DATABASE_URL uses Supabase session pooler (port 5432). " +
            "On Vercel this often hits EMAXCONNSESSION (pool_size: 15). " +
            "Switch to Transaction pooler port 6543 with ?pgbouncer=true&connection_limit=1. " +
            "See docs/SUPABASE.md",
        );
        if (!url.searchParams.has("connection_limit")) {
          url.searchParams.set("connection_limit", "1");
        }
      }
    }

    return url.toString();
  } catch {
    return raw;
  }
}

const datasourceUrl = resolveDatasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });

// Always reuse the client across hot reloads AND serverless invocations.
// Without this, each Vercel isolate can open many Prisma engines → pool exhaustion.
globalForPrisma.prisma = prisma;
