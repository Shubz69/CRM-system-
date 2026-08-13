import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { jsonError, requirePermission } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  AssetStorageNotConfiguredError,
  fetchAssetObjectBytes,
  verifyOrgScopedAssetContentUrl,
} from "@/services/asset-storage";

type Params = { params: Promise<{ id: string }> };

/**
 * Stream private asset bytes.
 * Auth: session for the asset's org, OR a short-lived HMAC signed query
 * (`org`, `exp`, `sig`) minted at read time. Never exposes a public blob URL.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const orgFromQuery = url.searchParams.get("org");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");

    let organisationId: string | null = null;

    if (
      orgFromQuery &&
      verifyOrgScopedAssetContentUrl({
        organisationId: orgFromQuery,
        assetId: id,
        exp,
        sig,
      })
    ) {
      organisationId = orgFromQuery;
    } else {
      try {
        const session = await requirePermission("agent:manage");
        organisationId = session.organisationId;
      } catch {
        const session = await getServerSession(authOptions);
        if (session?.user?.organisationId) {
          organisationId = session.user.organisationId;
        }
      }
    }

    if (!organisationId) {
      return jsonError("Unauthorized", 401);
    }

    const asset = await prisma.asset.findFirst({
      where: { id, organisationId },
      select: {
        id: true,
        organisationId: true,
        storageKey: true,
        url: true,
        mimeType: true,
      },
    });
    if (!asset) return jsonError("Asset not found", 404);

    const bytes = await fetchAssetObjectBytes({
      organisationId: asset.organisationId,
      storageKey: asset.storageKey,
      storedUrl: asset.url,
    });

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof AssetStorageNotConfiguredError) {
      return jsonError(
        "Image storage isn't set up yet. Ask an admin to configure ASSET_STORAGE.",
        503,
      );
    }
    return jsonError(message, 400);
  }
}
