import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { syncZernioConnectedAccounts } from "@/adapters/zernio";
import { logger } from "@/lib/logger";

/**
 * OAuth / connect callback after Zernio-hosted (or headless) account linking.
 * Syncs connected accounts into the org's ZernioProfile — never exposes API key.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    await syncZernioConnectedAccounts(session.organisationId).catch((error) => {
      logger.warn("Zernio callback sync soft-failed", {
        message: error instanceof Error ? error.message : "unknown",
        organisationId: session.organisationId,
      });
    });

    const error = req.nextUrl.searchParams.get("error");
    const dest = new URL("/integrations", req.nextUrl.origin);
    if (error) {
      dest.searchParams.set("social_error", error);
    } else {
      dest.searchParams.set("social_connected", "1");
    }
    return Response.redirect(dest);
  } catch {
    const dest = new URL("/login", req.nextUrl.origin);
    dest.searchParams.set("next", "/integrations");
    return Response.redirect(dest);
  }
}
