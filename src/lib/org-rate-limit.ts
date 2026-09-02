/**
 * Org-aware rate limits for expensive AI/content routes.
 * In-memory per process — sufficient for single-instance; multi-instance needs Redis.
 */

import { rateLimit } from "@/lib/rate-limit";

export type ExpensiveRouteKey = "ask" | "social-prospecting" | "research" | "content";

const ROUTE_LIMITS: Record<ExpensiveRouteKey, { limit: number; windowMs: number }> = {
  ask: { limit: 30, windowMs: 60_000 },
  "social-prospecting": { limit: 12, windowMs: 60_000 },
  research: { limit: 20, windowMs: 60_000 },
  content: { limit: 40, windowMs: 60_000 },
};

export class OrgRateLimitError extends Error {
  readonly code = "ORG_RATE_LIMIT";
  constructor(
    readonly organisationId: string,
    readonly route: ExpensiveRouteKey,
  ) {
    super("This workspace is sending requests too quickly. Please wait a moment and try again.");
    this.name = "OrgRateLimitError";
  }
}

export function assertOrgExpensiveRouteAllowed(
  organisationId: string,
  route: ExpensiveRouteKey,
): void {
  const cfg = ROUTE_LIMITS[route];
  const ok = rateLimit(`org-expensive:${route}:${organisationId}`, cfg.limit, cfg.windowMs);
  if (!ok) {
    throw new OrgRateLimitError(organisationId, route);
  }
}
