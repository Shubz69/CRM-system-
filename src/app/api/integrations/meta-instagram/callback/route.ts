import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { requirePermission } from "@/lib/session";
import {
  completeMetaInstagramConnection,
  consumeMetaInstagramOAuthState,
  exchangeMetaInstagramCode,
} from "@/services/messaging/meta-instagram";

function appUrl(): string {
  const env = getEnv();
  return (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

function redirectMeta(status: string, detail?: string) {
  const url = new URL(`${appUrl()}/integrations`);
  url.searchParams.set("meta_instagram", status);
  if (detail) url.searchParams.set("meta_instagram_error", detail.slice(0, 200));
  return NextResponse.redirect(url);
}

/** GET /api/integrations/meta-instagram/callback — exchange code, complete connection. */
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const providerError = searchParams.get("error_description") || searchParams.get("error");
  if (providerError) {
    return redirectMeta("denied", providerError);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return redirectMeta("error", "missing code or state");
  }

  const consumed = await consumeMetaInstagramOAuthState(state);
  if (!consumed) {
    return redirectMeta("error", "connection request expired or was invalid — try again");
  }

  let session: Awaited<ReturnType<typeof requirePermission>>;
  try {
    session = await requirePermission("integrations:manage");
  } catch {
    return NextResponse.redirect(`${appUrl()}/login`);
  }

  if (
    consumed.organisationId !== session.organisationId ||
    consumed.userId !== session.userId
  ) {
    return redirectMeta("error", "connection could not be verified — try again");
  }

  try {
    const exchanged = await exchangeMetaInstagramCode(code);
    const completed = await completeMetaInstagramConnection({
      organisationId: session.organisationId,
      userId: session.userId,
      accessToken: exchanged.accessToken,
      igUserId: exchanged.igUserId,
      username: exchanged.username,
      scopes: exchanged.scopes,
      expiresInSeconds: exchanged.expiresInSeconds,
    });
    if (!completed.ok) {
      return redirectMeta("incomplete", completed.error);
    }
    return redirectMeta("connected");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    return redirectMeta("error", message);
  }
}
