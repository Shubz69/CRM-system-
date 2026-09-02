import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import {
  buildCanonicalZernioNetworks,
  getOrCreateZernioProfile,
  syncZernioConnectedAccountsWithRetry,
  verifyZernioConnectState,
} from "@/adapters/zernio";
import { logger } from "@/lib/logger";

/**
 * OAuth / connect callback after Zernio account linking.
 *
 * Routes:
 * - GET /api/integrations/zernio/callback?state=...
 *
 * Contract:
 * 1. Session org must match signed `state` (HMAC + expiry)
 * 2. Bounded sync of connected accounts into that org's ZernioProfile only
 * 3. Redirect with deterministic success / sync-needed state for UI revalidation
 */
export async function GET(req: NextRequest) {
  const destBase = new URL("/integrations", req.nextUrl.origin);
  try {
    const session = await requireSession();
    const state = req.nextUrl.searchParams.get("state");
    const verified = verifyZernioConnectState(state, session.organisationId);
    if (!verified.ok) {
      logger.warn("Zernio callback state rejected", {
        code: verified.code,
        organisationId: session.organisationId,
      });
      destBase.searchParams.set("social_error", verified.code);
      return Response.redirect(destBase);
    }

    const oauthError = req.nextUrl.searchParams.get("error");
    if (oauthError) {
      destBase.searchParams.set("social_error", oauthError);
      return Response.redirect(destBase);
    }

    const sync = await syncZernioConnectedAccountsWithRetry(session.organisationId, {
      attempts: 3,
      delayMs: 800,
      requireConnected: true,
    });
    const profile = await getOrCreateZernioProfile(session.organisationId);
    const networks = buildCanonicalZernioNetworks({ profile });

    const connectedNetworks = [
      networks.instagram.connected ? "instagram" : null,
      networks.linkedin.connected ? "linkedin" : null,
    ].filter(Boolean);

    if (connectedNetworks.length > 0) {
      destBase.searchParams.set("social_connected", connectedNetworks.join(","));
      destBase.searchParams.set("social_status", "CONNECTED");
    } else if (!sync.ok) {
      destBase.searchParams.set("social_sync", "needed");
      destBase.searchParams.set("social_status", "DEGRADED");
      destBase.searchParams.set(
        "social_error",
        sync.error || "Connected with provider but local sync failed — retrying on page load",
      );
      logger.warn("Zernio callback sync failed after OAuth", {
        organisationId: session.organisationId,
        error: sync.error,
      });
    } else {
      // Provider eventual consistency — UI will bounded-resync
      destBase.searchParams.set("social_sync", "needed");
      destBase.searchParams.set("social_status", "CONNECTING");
    }

    return Response.redirect(destBase);
  } catch {
    const dest = new URL("/login", req.nextUrl.origin);
    dest.searchParams.set("next", "/integrations");
    return Response.redirect(dest);
  }
}
