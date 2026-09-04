/**
 * AI provider preflight — format + optional cheap auth check.
 * Never logs or returns secret values. Safe for worker health / internal ops.
 */

import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export type AiProviderPreflightStatus =
  | "NOT_CONFIGURED"
  | "FORMAT_INVALID"
  | "AUTH_INVALID"
  | "OK"
  | "SKIPPED";

export type AiProviderPreflightResult = {
  status: AiProviderPreflightStatus;
  /** Internal provider id — never send to customer UI */
  provider: string;
  configured: boolean;
  formatValid: boolean;
  authValid: boolean | null;
  degraded: boolean;
  detail: string;
  checkedAt: string;
};

let cached: AiProviderPreflightResult | null = null;
let authProbeInFlight: Promise<AiProviderPreflightResult> | null = null;

function formatValidAnthropicKey(key: string | undefined | null): boolean {
  if (!key || !String(key).trim()) return false;
  const t = String(key).trim();
  return /^sk-ant-/.test(t) && t.length >= 20;
}

function isAuthFailureBody(status: number, body: string): boolean {
  return (
    status === 401 ||
    /authentication_error|invalid.*api.?key|api key is invalid/i.test(body)
  );
}

/** Presence/format only — no network. */
export function getAiProviderConfigPreflight(): AiProviderPreflightResult {
  const env = getEnv();
  const provider = (env.AI_PROVIDER || "anthropic").toLowerCase();
  const checkedAt = new Date().toISOString();

  if (provider === "mock") {
    return {
      status: "OK",
      provider: "mock",
      configured: true,
      formatValid: true,
      authValid: true,
      degraded: false,
      detail: "Mock AI provider active",
      checkedAt,
    };
  }

  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    const configured = Boolean(key && String(key).trim());
    const formatValid = formatValidAnthropicKey(key);
    if (!configured) {
      return {
        status: "NOT_CONFIGURED",
        provider,
        configured: false,
        formatValid: false,
        authValid: false,
        degraded: true,
        detail: "ANTHROPIC_API_KEY missing",
        checkedAt,
      };
    }
    if (!formatValid) {
      return {
        status: "FORMAT_INVALID",
        provider,
        configured: true,
        formatValid: false,
        authValid: false,
        degraded: true,
        detail: "ANTHROPIC_API_KEY format invalid",
        checkedAt,
      };
    }
    return {
      status: "OK",
      provider,
      configured: true,
      formatValid: true,
      authValid: null,
      degraded: false,
      detail: "ANTHROPIC_API_KEY present — auth not probed",
      checkedAt,
    };
  }

  // Optional providers: report configured presence only.
  const keyLookup: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    groq: env.GROQ_API_KEY,
    mistral: env.MISTRAL_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    gemini: env.GEMINI_API_KEY,
  };
  const keyName =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "groq"
        ? "GROQ_API_KEY"
        : provider === "mistral"
          ? "MISTRAL_API_KEY"
          : provider === "deepseek"
            ? "DEEPSEEK_API_KEY"
            : provider === "gemini"
              ? "GEMINI_API_KEY"
              : null;
  const key = keyLookup[provider];
  const configured = Boolean(key && String(key).trim());
  return {
    status: configured ? "OK" : "NOT_CONFIGURED",
    provider,
    configured,
    formatValid: configured,
    authValid: null,
    degraded: !configured,
    detail: configured ? `${keyName} present` : `${keyName || "AI key"} missing`,
    checkedAt,
  };
}

/**
 * Cheap Anthropic auth probe (max_tokens=1). Cached for process lifetime after first probe.
 * Does not log response bodies that could leak material.
 */
export async function probeAiProviderAuth(options?: {
  force?: boolean;
}): Promise<AiProviderPreflightResult> {
  if (cached && !options?.force) return cached;
  if (authProbeInFlight && !options?.force) return authProbeInFlight;

  authProbeInFlight = (async () => {
    const base = getAiProviderConfigPreflight();
    if (base.provider !== "anthropic" || base.degraded) {
      cached = base;
      return base;
    }
    const env = getEnv();
    const apiKey = env.ANTHROPIC_API_KEY!;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_ECONOMY_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const body = await res.text();
      if (isAuthFailureBody(res.status, body)) {
        const result: AiProviderPreflightResult = {
          ...base,
          status: "AUTH_INVALID",
          authValid: false,
          degraded: true,
          detail: "Anthropic authentication failed (401)",
          checkedAt: new Date().toISOString(),
        };
        cached = result;
        logger.warn("AI provider preflight: authentication invalid", {
          provider: "anthropic",
          status: res.status,
        });
        return result;
      }
      // Non-401 errors (model 404, rate limit) still mean the key authenticated.
      const result: AiProviderPreflightResult = {
        ...base,
        status: "OK",
        authValid: true,
        degraded: false,
        detail: res.ok
          ? "Anthropic authentication OK"
          : `Anthropic key accepted (HTTP ${res.status})`,
        checkedAt: new Date().toISOString(),
      };
      cached = result;
      logger.info("AI provider preflight: OK", { provider: "anthropic", httpStatus: res.status });
      return result;
    } catch (error) {
      const result: AiProviderPreflightResult = {
        ...base,
        status: "SKIPPED",
        authValid: null,
        degraded: false,
        detail: "Auth probe network error — config present",
        checkedAt: new Date().toISOString(),
      };
      logger.warn("AI provider preflight: probe failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      // Do not cache hard failures forever — allow retry next call.
      return result;
    } finally {
      authProbeInFlight = null;
    }
  })();

  return authProbeInFlight;
}

export function getCachedAiProviderPreflight(): AiProviderPreflightResult | null {
  return cached;
}

/** Detect provider authentication failures from internal error strings. */
export function isAiProviderAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /authentication_error|api key is invalid|ANTHROPIC_API_KEY is not configured|\(401\)|invalid x-api-key/i.test(
    message,
  );
}

export const RESEARCH_SYNTHESIS_FAILED_CUSTOMER =
  "We found authoritative sources, but couldn't complete the analysis. Please try again shortly.";

export type ResearchCompletionPhase =
  | "EVIDENCE_GATHERED"
  | "SYNTHESIS_FAILED"
  | "QUALITY_REJECTED"
  | "SYNTHESIS_OK";
