import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import {
  buildCanonicalZernioNetworks,
  createZernioConnectUrl,
  disconnectZernioPlatformAccount,
  getOrCreateZernioProfile,
  getZernioProfileView,
  isZernioConfigured,
  maybeHealZernioAccountState,
  syncZernioConnectedAccountsWithRetry,
  zernioInstagramMessagingCapability,
  type ZernioConnectPlatform,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";
import { getEnv } from "@/lib/env";
import { getSocialConnectionPolicy } from "@/services/social-connection-policy";

function isConnectPlatform(value: unknown): value is ZernioConnectPlatform {
  return value === "instagram" || value === "linkedin" || value === "youtube";
}

export async function GET() {
  try {
    const session = await requirePermission("settings:read");
    const healed = await maybeHealZernioAccountState(session.organisationId);
    const profile = healed.profile;
    const view = await getZernioProfileView(session.organisationId);
    const networks = buildCanonicalZernioNetworks({ profile });
    const policy = await getSocialConnectionPolicy(session.organisationId);
    const accounts = Array.isArray(profile.connectedAccounts)
      ? (profile.connectedAccounts as ZernioConnectedAccount[])
      : [];
    const anyConnected = accounts.some((a) => {
      const s = String(a.status || "connected").toLowerCase();
      return !s.includes("disconnect") && s !== "revoked" && s !== "inactive";
    });

    const customerNetwork = (n: {
      network: string;
      status: string;
      connected: boolean;
      username?: string | null;
      displayName?: string | null;
      accountType?: string | null;
      health?: string;
    }) => ({
      network: n.network,
      status: n.status,
      connected: n.connected,
      username: n.username ?? null,
      displayName: n.displayName ?? null,
      accountType: n.accountType ?? null,
      health: n.connected ? "CONNECTED" : "DISCONNECTED",
    });

    return Response.json({
      ok: true,
      linkingAvailable: isZernioConfigured(),
      status: view.status,
      connected: anyConnected,
      healed: healed.healed,
      connectionPolicy: {
        socialConnectionsEnabled: policy.socialConnectionsEnabled,
        maxConnectedSocialAccounts: policy.maxConnectedSocialAccounts,
        allowedNetworks: policy.allowedNetworks,
        connectedCount: accounts.filter((a) => {
          const s = String(a.status || "connected").toLowerCase();
          return !s.includes("disconnect") && s !== "revoked" && s !== "inactive";
        }).length,
      },
      networks: {
        instagram: {
          ...customerNetwork(networks.instagram),
          messaging: {
            directMessages: Boolean(
              zernioInstagramMessagingCapability(networks.instagram.connected).directMessages,
            ),
          },
          publishing: networks.instagram.connected,
        },
        linkedin: {
          ...customerNetwork(networks.linkedin),
          messaging: { directMessages: false },
          publishing: networks.linkedin.connected,
        },
        youtube: {
          ...customerNetwork(networks.youtube),
          messaging: { directMessages: false },
          publishing: false,
          outreach: "OPEN_COPY",
        },
      },
      connectedAccounts: accounts
        .filter((a) => {
          const s = String(a.status || "connected").toLowerCase();
          return !s.includes("disconnect") && s !== "revoked" && s !== "inactive";
        })
        .map((a) => ({
          platform: a.platform,
          username: a.username || null,
          displayName: a.displayName || null,
          status: a.status || "connected",
        })),
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
      if (!isConnectPlatform(platform)) {
        return jsonError("platform must be instagram, linkedin, or youtube", 400);
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
        const status =
          result.code === "ZERNIO_NOT_CONFIGURED"
            ? 503
            : result.code === "SOCIAL_CONNECTION_QUOTA" ||
                result.code === "SOCIAL_CONNECTIONS_DISABLED" ||
                result.code === "SOCIAL_NETWORK_NOT_ALLOWED"
              ? 403
              : 400;
        return Response.json(result, { status });
      }
      return Response.json({
        ok: true,
        url: result.url,
        headless: result.headless === true,
        platform,
      });
    }

    if (action === "sync") {
      const result = await syncZernioConnectedAccountsWithRetry(session.organisationId, {
        attempts: 3,
        delayMs: 600,
        requireConnected: false,
      });
      const profile = await getOrCreateZernioProfile(session.organisationId);
      const networks = buildCanonicalZernioNetworks({ profile });
      return Response.json(
        {
          ...result,
          networks,
        },
        { status: result.ok ? 200 : 400 },
      );
    }

    if (action === "disconnect") {
      const platform = body.platform;
      if (!isConnectPlatform(platform)) {
        return jsonError("platform must be instagram, linkedin, or youtube", 400);
      }
      const result = await disconnectZernioPlatformAccount({
        organisationId: session.organisationId,
        platform,
        userId: session.userId,
      });
      const profile = await getOrCreateZernioProfile(session.organisationId);
      const networks = buildCanonicalZernioNetworks({ profile });
      return Response.json(
        {
          ...result,
          networks,
          preserved: {
            contacts: true,
            conversations: true,
            messages: true,
            publishedContentAudit: true,
          },
        },
        {
          status: result.ok
            ? 200
            : result.code === "RECONCILIATION_REQUIRED"
              ? 409
              : result.code === "ZERNIO_NOT_CONFIGURED"
                ? 503
                : 400,
        },
      );
    }

    if (action === "disconnect_local") {
      return jsonError("Use action: disconnect for provider revoke", 400);
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    if (message === "FORBIDDEN") return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
