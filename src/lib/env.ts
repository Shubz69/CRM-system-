import { z } from "zod";

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

export function getEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const data = parsed.data;
  if (!data.AUTH_SECRET && !data.NEXTAUTH_SECRET) {
    if (data.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required in production");
    }
    data.AUTH_SECRET = "dev-only-auth-secret-change-me";
    data.NEXTAUTH_SECRET = data.AUTH_SECRET;
  }
  cached = data;
  return cached;
}

export function getAuthSecret(): string {
  const env = getEnv();
  return env.NEXTAUTH_SECRET || env.AUTH_SECRET || "dev-only-auth-secret-change-me";
}
