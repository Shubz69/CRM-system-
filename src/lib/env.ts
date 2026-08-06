import { z } from "zod";

const BUILD_PLACEHOLDER_DATABASE_URL =
  "postgresql://build:build@127.0.0.1:5432/build?schema=public";

function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(16).optional(),
  NEXTAUTH_SECRET: z.string().min(16).optional(),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  APP_URL: z.string().default("http://localhost:3000"),
  AI_PROVIDER: z.enum(["mock", "openai", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  MANYCHAT_API_BASE_URL: z.string().default("https://api.manychat.com"),
  MANYCHAT_API_TOKEN: z.string().optional(),
  MANYCHAT_WEBHOOK_SECRET: z.string().default("dev-manychat-webhook-secret"),
  BOOKING_PROVIDER: z.string().default("link"),
  BOOKING_WEBHOOK_SECRET: z.string().default("dev-booking-webhook-secret"),
  DEFAULT_BOOKING_URL: z.string().optional(),
  GOOGLE_SHEETS_CREDENTIALS_JSON: z.string().optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
  EMAIL_SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z
    .string()
    .length(64)
    .default("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

const DEV_WEBHOOK_SECRETS = new Set([
  "dev-manychat-webhook-secret",
  "dev-booking-webhook-secret",
]);

export function getEnv(): AppEnv {
  if (cached) return cached;

  // Vercel/Next collect page data during `next build` without runtime secrets.
  // Provide safe placeholders so compile succeeds; runtime still requires real values.
  if (isProductionBuild()) {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = BUILD_PLACEHOLDER_DATABASE_URL;
    }
    if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
      process.env.AUTH_SECRET = "build-only-auth-secret-not-for-runtime";
      process.env.NEXTAUTH_SECRET = process.env.AUTH_SECRET;
    }
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const data = parsed.data;
  if (!data.AUTH_SECRET && !data.NEXTAUTH_SECRET) {
    if (data.NODE_ENV === "production" && !isProductionBuild()) {
      throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required in production");
    }
    data.AUTH_SECRET = "dev-only-auth-secret-change-me";
    data.NEXTAUTH_SECRET = data.AUTH_SECRET;
  }

  if (data.NODE_ENV === "production" && !isProductionBuild()) {
    if (data.DATABASE_URL === BUILD_PLACEHOLDER_DATABASE_URL) {
      throw new Error("DATABASE_URL must be set to a real Postgres URL in production");
    }
    if (DEV_WEBHOOK_SECRETS.has(data.MANYCHAT_WEBHOOK_SECRET)) {
      throw new Error("MANYCHAT_WEBHOOK_SECRET must be rotated away from the default in production");
    }
    if (DEV_WEBHOOK_SECRETS.has(data.BOOKING_WEBHOOK_SECRET)) {
      throw new Error("BOOKING_WEBHOOK_SECRET must be rotated away from the default in production");
    }
    if (
      data.ENCRYPTION_KEY ===
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ) {
      throw new Error("ENCRYPTION_KEY must be unique in production");
    }
  }

  cached = data;
  return cached;
}

/** Test helper to clear cached env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export function getAuthSecret(): string {
  const env = getEnv();
  return env.NEXTAUTH_SECRET || env.AUTH_SECRET || "dev-only-auth-secret-change-me";
}

export function isDemoModeEnabled(): boolean {
  const env = getEnv();
  if (env.NODE_ENV === "production" && !env.DEMO_MODE) return false;
  return Boolean(env.DEMO_MODE) || env.NODE_ENV === "development" || env.NODE_ENV === "test";
}
