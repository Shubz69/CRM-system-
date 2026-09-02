import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { syncZernioConnectedAccounts, verifyZernioConnectState } from "@/adapters/zernio";
import { logger } from "@/lib/logger";

/**
 * OAuth / connect callback after Zernio account linking.
 *
 * Routes:
 * - GET /api/integrations/zernio/callback?state=...
 *
 * Contract:
 * 1. Session org must match signed `state` (HMAC + expiry) — prevents cross-org profile assignment
 * 2. Sync connected accounts into that org's ZernioProfile only
 * 3. Never expose ZERNIO_API_KEY
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

    await syncZernioConnectedAccounts(session.organisationId).catch((error) => {
      logger.warn("Zernio callback sync soft-failed", {
        message: error instanceof Error ? error.message : "unknown",
        organisationId: session.organisationId,
      });
    });

    const error = req.nextUrl.searchParams.get("error");
    if (error) {
      destBase.searchParams.set("social_error", error);
    } else {
      destBase.searchParams.set("social_connected", "1");
    }
    return Response.redirect(destBase);
  } catch {
    const dest = new URL("/login", req.nextUrl.origin);
    dest.searchParams.set("next", "/integrations");
    return Response.redirect(dest);
  }
}
