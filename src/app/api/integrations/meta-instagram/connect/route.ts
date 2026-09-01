import { NextResponse } from "next/server";
import {
  MetaInstagramNotConfiguredError,
  assertMetaInstagramMessagingConfigured,
  getEnv,
  metaInstagramNotConfiguredResponse,
} from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";
import {
  buildMetaInstagramAuthorizeUrl,
  createMetaInstagramOAuthState,
  isMetaInstagramAppConfigured,
} from "@/services/messaging/meta-instagram";

function appUrl(): string {
  const env = getEnv();
  return (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** GET /api/integrations/meta-instagram/connect — start OAuth, redirect to Meta. */
export async function GET() {
  let session: Awaited<ReturnType<typeof requirePermission>>;
  try {
    session = await requirePermission("integrations:manage");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return NextResponse.redirect(`${appUrl()}/login`);
    return jsonError(message, 403);
  }

  try {
    assertMetaInstagramMessagingConfigured();
  } catch (error) {
    if (error instanceof MetaInstagramNotConfiguredError) {
      return metaInstagramNotConfiguredResponse(503);
    }
    throw error;
  }

  if (!isMetaInstagramAppConfigured()) {
    return metaInstagramNotConfiguredResponse(503);
  }

  try {
    const state = await createMetaInstagramOAuthState({
      organisationId: session.organisationId,
      userId: session.userId,
    });
    const authorizeUrl = buildMetaInstagramAuthorizeUrl(state);
    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start Instagram connection";
    return NextResponse.redirect(
      `${appUrl()}/integrations?meta_instagram=error&meta_instagram_error=${encodeURIComponent(message)}`,
    );
  }
}
