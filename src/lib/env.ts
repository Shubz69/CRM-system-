import { z } from "zod";

const BUILD_PLACEHOLDER_DATABASE_URL =
  "postgresql://build:build@127.0.0.1:5432/build?schema=public";

function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

function isRuntimeProduction(): boolean {
  return process.env.NODE_ENV === "production" && !isProductionBuild();
}

const envSchema = z.object({
  DATABASE_URL: z.string().optional().default(""),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(16).optional(),
  NEXTAUTH_SECRET: z.string().min(16).optional(),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  APP_URL: z.string().default("http://localhost:3000"),
  // Primary AI provider is Anthropic Claude. OpenAI is optional and never required.
  AI_PROVIDER: z.enum(["mock", "openai", "anthropic"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_DEFAULT_MODEL: z.string().optional(),
  ANTHROPIC_ECONOMY_MODEL: z.string().optional(),
  ANTHROPIC_ADVANCED_MODEL: z.string().optional(),
  ANTHROPIC_MAX_TOKENS: z.string().optional(),
  ANTHROPIC_TIMEOUT_MS: z.string().optional(),
  ANTHROPIC_RETRIES: z.string().optional(),
  ANTHROPIC_TEMPERATURE: z.string().optional(),
  /** OPTIONAL — not required for production. Kept only for the optional OpenAI adapter. */
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
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_INITIAL_PASSWORD: z.string().optional(),
  ADMIN_FORCE_PASSWORD_CHANGE: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
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
    if (isRuntimeProduction()) {
      console.warn(
        "[env] AUTH_SECRET / NEXTAUTH_SECRET missing — using ephemeral fallback. Set secrets in Vercel.",
      );
    }
    data.AUTH_SECRET = "dev-only-auth-secret-change-me";
    data.NEXTAUTH_SECRET = data.AUTH_SECRET;
  }

  if (isRuntimeProduction()) {
    if (!data.DATABASE_URL || data.DATABASE_URL === BUILD_PLACEHOLDER_DATABASE_URL) {
      console.warn(
        "[env] DATABASE_URL is not configured. Landing/login will load; API/DB routes will fail until set.",
      );
    }
    if (DEV_WEBHOOK_SECRETS.has(data.MANYCHAT_WEBHOOK_SECRET)) {
      console.warn("[env] MANYCHAT_WEBHOOK_SECRET is still the default — rotate before production traffic.");
    }
    if (DEV_WEBHOOK_SECRETS.has(data.BOOKING_WEBHOOK_SECRET)) {
      console.warn("[env] BOOKING_WEBHOOK_SECRET is still the default — rotate before production traffic.");
    }
    if (
      data.ENCRYPTION_KEY ===
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ) {
      console.warn("[env] ENCRYPTION_KEY is still the default — rotate before storing secrets.");
    }
  }

  cached = data;
  return cached;
}

export function requireDatabaseUrl(): string {
  const url = getEnv().DATABASE_URL;
  if (!url || url === BUILD_PLACEHOLDER_DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Add a Postgres connection string in Vercel → Settings → Environment Variables.",
    );
  }
  return url;
}

export function assertWebhookSecretsConfigured(): void {
  if (!isRuntimeProduction()) return;
  const env = getEnv();
  if (DEV_WEBHOOK_SECRETS.has(env.MANYCHAT_WEBHOOK_SECRET)) {
    throw new Error("MANYCHAT_WEBHOOK_SECRET must be rotated away from the default in production");
  }
  if (DEV_WEBHOOK_SECRETS.has(env.BOOKING_WEBHOOK_SECRET)) {
    throw new Error("BOOKING_WEBHOOK_SECRET must be rotated away from the default in production");
  }
}

export function resetEnvCache(): void {
  cached = null;
}

export function getAuthSecret(): string {
  const direct = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (direct && direct.length >= 16) return direct;
  if (isProductionBuild()) return "build-only-auth-secret-not-for-runtime";
  return getEnv().NEXTAUTH_SECRET || getEnv().AUTH_SECRET || "dev-only-auth-secret-change-me";
}

export function isDemoModeEnabled(): boolean {
  const env = getEnv();
  if (env.NODE_ENV === "production" && !env.DEMO_MODE) return false;
  return Boolean(env.DEMO_MODE) || env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

export function getMissingRuntimeConfig(): string[] {
  const env = getEnv();
  const missing: string[] = [];
  if (!env.DATABASE_URL || env.DATABASE_URL === BUILD_PLACEHOLDER_DATABASE_URL) {
    missing.push("DATABASE_URL");
  }
  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (
    !secret ||
    secret === "dev-only-auth-secret-change-me" ||
    secret === "build-only-auth-secret-not-for-runtime"
  ) {
    missing.push("AUTH_SECRET / NEXTAUTH_SECRET");
  }
  return missing;
}
