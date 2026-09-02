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
  // Primary AI provider is Anthropic Claude. All others below are optional and never required.
  AI_PROVIDER: z
    .enum(["mock", "openai", "anthropic", "groq", "mistral", "deepseek", "gemini"])
    .default("anthropic"),
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
  /**
   * OPTIONAL secondary/free-tier AI providers (see docs/AI_PROVIDERS.md).
   * Reached only via an explicit getAiProvider(name) override or a global
   * AI_PROVIDER switch — Anthropic stays primary unless one is chosen.
   * Unset → SocialNotConfigured-style fail-closed fallback to Anthropic
   * (or mock outside production), never a silent broken call.
   */
  GROQ_API_KEY: z.string().optional(),
  GROQ_ECONOMY_MODEL: z.string().optional(),
  GROQ_DEFAULT_MODEL: z.string().optional(),
  GROQ_ADVANCED_MODEL: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_ECONOMY_MODEL: z.string().optional(),
  MISTRAL_DEFAULT_MODEL: z.string().optional(),
  MISTRAL_ADVANCED_MODEL: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_ECONOMY_MODEL: z.string().optional(),
  DEEPSEEK_DEFAULT_MODEL: z.string().optional(),
  DEEPSEEK_ADVANCED_MODEL: z.string().optional(),
  /** Chat model overrides for Gemini — shares GEMINI_API_KEY with the image adapter below. */
  GEMINI_CHAT_ECONOMY_MODEL: z.string().optional(),
  GEMINI_CHAT_DEFAULT_MODEL: z.string().optional(),
  GEMINI_CHAT_ADVANCED_MODEL: z.string().optional(),
  /**
   * Embedding provider for hybrid knowledge retrieval.
   * none (default) → lexical-only with an explicit log (never silent).
   * openai → OpenAI embeddings API (uses EMBEDDING_API_KEY or OPENAI_API_KEY).
   * mock → deterministic vectors for local/demo only.
   */
  EMBEDDING_PROVIDER: z.enum(["none", "openai", "mock"]).default("none"),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  /** Research source adapters */
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_RATE_LIMIT_PER_MIN: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),
  REDDIT_RATE_LIMIT_PER_MIN: z.string().optional(),
  /** tavily (default) | exa */
  WEB_SEARCH_PROVIDER: z.enum(["tavily", "exa"]).default("tavily"),
  TAVILY_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  WEB_SEARCH_RATE_LIMIT_PER_MIN: z.string().optional(),
  RESEARCH_CACHE_TTL_SECONDS: z.string().optional(),
  RESEARCH_ADAPTER_CONCURRENCY: z.string().optional(),
  /**
   * Apify API token for Instagram / LinkedIn / TikTok licensed data.
   * Unset → those adapters throw SourceNotConfiguredError (never fake/empty).
   */
  APIFY_TOKEN: z.string().optional(),
  /** Global per-actor timeout ms (default 75s). Cap enforced in adapter (max 180s). */
  APIFY_TIMEOUT_MS: z.string().optional(),
  APIFY_INSTAGRAM_TIMEOUT_MS: z.string().optional(),
  APIFY_LINKEDIN_TIMEOUT_MS: z.string().optional(),
  APIFY_TIKTOK_TIMEOUT_MS: z.string().optional(),
  APIFY_TWITTER_TIMEOUT_MS: z.string().optional(),
  APIFY_THREADS_TIMEOUT_MS: z.string().optional(),
  /** Optional actor id overrides (owner/name). Defaults are documented in apify-platforms.ts. */
  APIFY_INSTAGRAM_ACTOR_ID: z.string().optional(),
  APIFY_LINKEDIN_ACTOR_ID: z.string().optional(),
  APIFY_TIKTOK_ACTOR_ID: z.string().optional(),
  APIFY_TWITTER_ACTOR_ID: z.string().optional(),
  APIFY_THREADS_ACTOR_ID: z.string().optional(),
  /** Fallback USD / 1k results when Apify omits usageTotalUsd. */
  APIFY_USD_PER_1K_RESULTS: z.string().optional(),
  APIFY_RATE_LIMIT_PER_MIN: z.string().optional(),
  /**
   * Image generation provider. none → explicit error (never a placeholder image).
   * Claude/Anthropic is never a valid generator (rejected at getImageProvider).
   */
  IMAGE_PROVIDER: z.string().default("none"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_IMAGE_MODEL: z.string().optional(),
  GEMINI_IMAGE_MODEL_FALLBACK: z.string().optional(),
  GEMINI_IMAGE_COST_CENTS: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().optional(),
  OPENAI_IMAGE_COST_CENTS: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().optional(),
  /** vercel_blob | s3 | none — unconfigured means explicit error, never DB blobs. */
  ASSET_STORAGE: z.string().default("none"),
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  MANYCHAT_API_BASE_URL: z.string().default("https://api.manychat.com"),
  MANYCHAT_API_TOKEN: z.string().optional(),
  MANYCHAT_WEBHOOK_SECRET: z.string().default("dev-manychat-webhook-secret"),
  /**
   * Social Connections + native Instagram DMs share one Meta App.
   * Canonical keys: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_GRAPH_API_VERSION
   * Aliases META_APP_ID / META_APP_SECRET are fallbacks only when INSTAGRAM_* unset.
   * Precedence: INSTAGRAM_* wins whenever set (never prefer META_* over INSTAGRAM_*).
   */
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_REDIRECT_URI: z.string().optional(),
  /** Graph API version for Instagram Login + Send API. Default v26.0 (Aug 2026). */
  INSTAGRAM_GRAPH_API_VERSION: z.string().default("v26.0"),
  /** Fallback aliases only — used when corresponding INSTAGRAM_* is unset. */
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /** Meta webhook subscription verify token for Instagram messaging. */
  META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().default("dev-meta-instagram-verify-token"),
  /** OAuth redirect for native Instagram messaging Login (defaults to APP_URL callback). */
  META_INSTAGRAM_MESSAGING_REDIRECT_URI: z.string().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().optional(),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_REDIRECT_URI: z.string().optional(),
  /** Ayrshare primary API key — SERVER ONLY. Never expose to browser. */
  AYRSHARE_API_KEY: z.string().optional(),
  AYRSHARE_DOMAIN: z.string().optional(),
  AYRSHARE_PRIVATE_KEY: z.string().optional(),
  AYRSHARE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * LinkedIn restricted communication APIs — NOT user-settable product toggles.
   * Require BOTH the capability flag AND ALLOW_LINKEDIN_RESTRICTED_APIS=1.
   * Default: disabled (Version 1 Open/Copy workflow).
   */
  LINKEDIN_INVITATIONS_API_APPROVED: z.string().optional(),
  LINKEDIN_CONNECTIONS_API_APPROVED: z.string().optional(),
  LINKEDIN_MESSAGES_API_APPROVED: z.string().optional(),
  ALLOW_LINKEDIN_RESTRICTED_APIS: z.string().optional(),
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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

/** Globally mandatory webhook defaults — optional providers must not be listed here. */
const GLOBAL_DEV_WEBHOOK_SECRETS = new Set([
  "dev-manychat-webhook-secret",
  "dev-booking-webhook-secret",
]);

/** Optional Meta Instagram default — never a worker/global production hard-fail. */
export const META_INSTAGRAM_DEV_VERIFY_TOKEN = "dev-meta-instagram-verify-token";

export class MetaInstagramNotConfiguredError extends Error {
  readonly code = "META_NOT_CONFIGURED" as const;
  constructor(message = "Meta Instagram is not configured") {
    super(message);
    this.name = "MetaInstagramNotConfiguredError";
  }
}

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

  // On Vercel, derive auth/app URLs from the deployment host when unset so
  // credentials callbacks don't CSRF-fail against localhost defaults.
  if (!process.env.NEXTAUTH_URL && process.env.VERCEL_URL) {
    process.env.NEXTAUTH_URL = `https://${process.env.VERCEL_URL}`;
  }
  if (!process.env.APP_URL && process.env.NEXTAUTH_URL) {
    process.env.APP_URL = process.env.NEXTAUTH_URL;
  }
  if (!process.env.APP_URL && process.env.VERCEL_URL) {
    process.env.APP_URL = `https://${process.env.VERCEL_URL}`;
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
    if (data.NEXTAUTH_URL.includes("localhost")) {
      console.warn(
        "[env] NEXTAUTH_URL still points at localhost — set it to your Vercel URL to avoid auth callback 401s.",
      );
    }
    if (GLOBAL_DEV_WEBHOOK_SECRETS.has(data.MANYCHAT_WEBHOOK_SECRET)) {
      console.warn("[env] MANYCHAT_WEBHOOK_SECRET is still the default — rotate before production traffic.");
    }
    if (GLOBAL_DEV_WEBHOOK_SECRETS.has(data.BOOKING_WEBHOOK_SECRET)) {
      console.warn("[env] BOOKING_WEBHOOK_SECRET is still the default — rotate before production traffic.");
    }
    const metaAppPresent = Boolean(
      data.INSTAGRAM_APP_ID?.trim() ||
        data.INSTAGRAM_APP_SECRET?.trim() ||
        data.META_APP_ID?.trim() ||
        data.META_APP_SECRET?.trim(),
    );
    if (metaAppPresent && data.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN === META_INSTAGRAM_DEV_VERIFY_TOKEN) {
      console.warn(
        "[env] META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN is still the default — rotate before Meta Instagram webhook traffic. This does not block worker startup.",
      );
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

/**
 * Globally mandatory webhook secrets only (ManyChat + booking).
 * Optional connectors (Meta Instagram, etc.) must not be asserted here —
 * an unconfigured optional provider must never take down the worker.
 */
export function assertWebhookSecretsConfigured(): void {
  if (!isRuntimeProduction()) return;
  const env = getEnv();
  if (GLOBAL_DEV_WEBHOOK_SECRETS.has(env.MANYCHAT_WEBHOOK_SECRET)) {
    throw new Error("MANYCHAT_WEBHOOK_SECRET must be rotated away from the default in production");
  }
  if (GLOBAL_DEV_WEBHOOK_SECRETS.has(env.BOOKING_WEBHOOK_SECRET)) {
    throw new Error("BOOKING_WEBHOOK_SECRET must be rotated away from the default in production");
  }
}

function metaInstagramAppCredentialsPresent(env: AppEnv): boolean {
  const appId = env.INSTAGRAM_APP_ID?.trim() || env.META_APP_ID?.trim();
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim() || env.META_APP_SECRET?.trim();
  return Boolean(appId && appSecret);
}

export function isMetaInstagramVerifyTokenProductionReady(token?: string | null): boolean {
  const value = (token ?? getEnv().META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  return Boolean(value) && value !== META_INSTAGRAM_DEV_VERIFY_TOKEN;
}

/**
 * Provider-scoped Meta Instagram readiness.
 * Call only from Meta OAuth, Meta webhooks, Meta validation, subscription, and Meta outbound.
 * Missing configuration → META_NOT_CONFIGURED (never process.exit).
 */
export function assertMetaInstagramMessagingConfigured(): void {
  const env = getEnv();
  if (!metaInstagramAppCredentialsPresent(env)) {
    throw new MetaInstagramNotConfiguredError(
      "Meta Instagram app credentials are not configured (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)",
    );
  }
  if (isRuntimeProduction() && !isMetaInstagramVerifyTokenProductionReady(env.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN)) {
    throw new MetaInstagramNotConfiguredError(
      "META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN must be rotated away from the default before using Meta Instagram",
    );
  }
}

/** Safe JSON for Meta endpoints when the optional provider is not configured. */
export function metaInstagramNotConfiguredResponse(status = 503) {
  return Response.json(
    {
      ok: false,
      error: "Meta Instagram is not configured",
      code: "META_NOT_CONFIGURED",
      health: "NOT_CONFIGURED",
    },
    { status },
  );
}

const DEFAULT_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * Production hard-fail for secrets that are globally mandatory for the runtime.
 * Optional providers (Meta Instagram, etc.) must use provider-scoped asserts.
 * Does NOT rotate ENCRYPTION_KEY — see docs/CREDENTIAL-ROTATION.md.
 * Call from worker boot and globally required webhook ingress (ManyChat, booking).
 */
export function assertProductionSecretsConfigured(): void {
  if (!isRuntimeProduction()) return;
  assertWebhookSecretsConfigured();
  const env = getEnv();
  if (env.ENCRYPTION_KEY === DEFAULT_ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY is still the default. Generate a unique 64-hex key before storing secrets. See docs/CREDENTIAL-ROTATION.md — do not rewrite the key against existing ciphertext without a migration plan.",
    );
  }
  const auth =
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    env.NEXTAUTH_SECRET ||
    env.AUTH_SECRET ||
    "";
  if (
    !auth ||
    auth === "dev-only-auth-secret-change-me" ||
    auth === "build-only-auth-secret-not-for-runtime" ||
    auth.length < 16
  ) {
    throw new Error(
      "AUTH_SECRET / NEXTAUTH_SECRET must be set to a strong non-default value in production",
    );
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
