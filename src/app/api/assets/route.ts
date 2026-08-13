import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import {
  AssetStorageNotConfiguredError,
  createReferenceAsset,
} from "@/services/assets";

/** Upload a reference image as an org-scoped Asset (object storage only). */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("Choose an image file to upload.", 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const asset = await createReferenceAsset({
      organisationId: session.organisationId,
      userId: session.userId,
      filename: file.name || "reference.png",
      mimeType,
      bytes,
    });

    return Response.json({
      ok: true,
      assetId: asset.id,
      url: asset.url,
      mimeType: asset.mimeType,
      message: "Reference image uploaded. Describe what you want next.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof AssetStorageNotConfiguredError) {
      return jsonError(
        "Image storage isn't set up yet. Ask an admin to configure ASSET_STORAGE (Vercel Blob or S3).",
        503,
      );
    }
    return jsonError(message, 400);
  }
}
