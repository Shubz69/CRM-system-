/**
 * SSRF-safe fetch for user-controlled or untrusted URLs.
 * Blocks private/link-local/metadata hosts. Use for mediaUrl and similar.
 * Known first-party API hosts should continue using plain fetch.
 */

import { logger } from "@/lib/logger";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
]);

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "[::1]") return true;
  if (isPrivateIpv4(host)) return true;
  // IPv6 unique local / link-local (simplified)
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function assertUrlSafeForServerFetch(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfBlockedError(`Blocked URL protocol: ${url.protocol}`);
  }
  // Prefer HTTPS for untrusted media; allow http only in non-production for local fixtures.
  if (url.protocol === "http:" && process.env.NODE_ENV === "production") {
    throw new SsrfBlockedError("HTTP URLs are blocked in production for untrusted fetches");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SsrfBlockedError(`Blocked hostname: ${url.hostname}`);
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("URLs with embedded credentials are blocked");
  }
  return url;
}

export type SafeFetchOptions = RequestInit & {
  /** Max redirect hops (default 3). Each hop re-validated. */
  maxRedirects?: number;
  timeoutMs?: number;
};

/**
 * Fetch a user-supplied URL with SSRF protections.
 * Does not follow redirects blindly to private hosts.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchOptions = {},
): Promise<Response> {
  const { maxRedirects = 3, timeoutMs = 30_000, redirect: _ignored, ...rest } = init;
  let current = assertUrlSafeForServerFetch(rawUrl).toString();
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        ...rest,
        redirect: "manual",
        signal: rest.signal ?? controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc || redirects >= maxRedirects) {
          throw new SsrfBlockedError("Too many or missing redirects");
        }
        const next = new URL(loc, current).toString();
        assertUrlSafeForServerFetch(next);
        current = next;
        redirects += 1;
        continue;
      }
      return res;
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      logger.warn("safeFetch failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
