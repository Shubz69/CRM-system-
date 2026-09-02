import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import {
  createZernioConnectUrl,
  getOrCreateZernioProfile,
  getZernioNetworkHealth,
  getZernioProfileView,
  isZernioConfigured,
  isZernioWebhookConfigured,
  preferredProviderForCapability,
  syncZernioConnectedAccounts,
  zernioInstagramMessagingCapability,
  zernioLinkedInMessagingCapability,
  type ZernioConnectPlatform,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";
import { resolveProviderPlatformCapability } from "@/services/social-prospecting/capabilities";
import { getEnv } from "@/lib/env";
import { zernioColdInstagramOutreachMode } from "@/adapters/messaging/zernio";

export async function GET() {
  try {
    const session = await requirePermission("settings:read");
    const view = await getZernioProfileView(session.organisationId);
    const profile = await getOrCreateZernioProfile(session.organisationId);
    const health = getZernioNetworkHealth(profile);
    const accounts = view.connectedAccounts as ZernioConnectedAccount[];
    const igConnected = accounts.some((a) => String(a.platform).includes("instagram"));
    const liConnected = accounts.some((a) => String(a.platform).includes("linkedin"));

    return Response.json({
      ok: true,
      serverConfigured: isZernioConfigured(),
      webhookConfigured: isZernioWebhookConfigured(),
      ...view,
      health,
      networks: {
        instagram: {
          connected: igConnected,
          status: health.instagram,
          requiresProfessionalAccount: true,
          requiresFacebookPage: false,
          connectMethod: "instagram_login",
          messaging: zernioInstagramMessagingCapability(igConnected),
          coldOutreach: zernioColdInstagramOutreachMode(),
          preferredProvider: preferredProviderForCapability({
            network: "INSTAGRAM",
            capability: "CONNECT_ACCOUNT",
          }),
        },
        linkedin: {
          connected: liConnected,
          status: health.linkedin,
          messaging: zernioLinkedInMessagingCapability(),
          outreach: "OPEN_COPY",
          preferredProvider: preferredProviderForCapability({
            network: "LINKEDIN",
            capability: "CONNECT_ACCOUNT",
          }),
          dmCapability: resolveProviderPlatformCapability({
            provider: "ZERNIO",
            network: "LINKEDIN",
            capability: "DIRECT_MESSAGES",
          }),
        },
      },
      routes: {
        profile: "GET/POST /api/integrations/zernio",
        connectUrl: "POST /api/integrations/zernio { action: connect, platform }",
        callback: "GET /api/integrations/zernio/callback?state=",
        sync: "POST /api/integrations/zernio { action: sync }",
        webhook: "POST /api/webhooks/zernio",
      },
      /** Diagnostics only — not shown as product branding */
      providerId: "ZERNIO",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    return jsonError(message, 403);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      platform?: ZernioConnectPlatform;
      headless?: boolean;
    };
    const action = body.action || "connect";

    if (action === "connect") {
      const platform = body.platform;
      if (platform !== "instagram" && platform !== "linkedin") {
        return jsonError("platform must be instagram or linkedin", 400);
      }
      const env = getEnv();
      const appUrl = (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
      const redirectUrl = `${appUrl}/api/integrations/zernio/callback`;
      const result = await createZernioConnectUrl({
        organisationId: session.organisationId,
        platform,
        redirectUrl,
        headless: body.headless === true,
      });
      if (!result.ok) {
        return Response.json(result, {
          status: result.code === "ZERNIO_NOT_CONFIGURED" ? 503 : 400,
        });
      }
      // Never return API key — only the provider OAuth URL
      return Response.json({
        ok: true,
        url: result.url,
        headless: result.headless === true,
        platform,
      });
    }

    if (action === "sync") {
      const result = await syncZernioConnectedAccounts(session.organisationId);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (action === "disconnect_local") {
      // Soft local disconnect marker — does not call Zernio revoke in V1 validation scope
      const { prisma } = await import("@/lib/db");
      await prisma.zernioProfile.updateMany({
        where: { organisationId: session.organisationId },
        data: {
          connectedAccounts: [],
          status: "DISCONNECTED",
          lastSyncAt: new Date(),
        },
      });
      return Response.json({ ok: true });
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    if (message === "FORBIDDEN") return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
