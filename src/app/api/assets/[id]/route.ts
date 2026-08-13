import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import {
  AssetStorageNotConfiguredError,
  getOrgAsset,
} from "@/services/assets";

type Params = { params: Promise<{ id: string }> };

/** Org-scoped asset metadata + signed URL. Cross-org ids return 404. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("agent:manage");
    const { id } = await params;
    const asset = await getOrgAsset({
      organisationId: session.organisationId,
      assetId: id,
    });
    if (!asset) return jsonError("Asset not found", 404);
    return Response.json({
      ok: true,
      asset: {
        id: asset.id,
        url: asset.signedUrl,
        signedUrl: asset.signedUrl,
        mimeType: asset.mimeType,
        kind: asset.kind,
        prompt: asset.prompt,
        costCents: asset.costCents,
        provider: asset.provider,
        model: asset.model,
        derivedFromAssetId: asset.derivedFromAssetId,
        storageKey: asset.storageKey,
        expiresAt: asset.expiresAt,
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
