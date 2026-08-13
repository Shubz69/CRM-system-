import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  AssetStorageNotConfiguredError,
  buildAssetStorageKey,
  buildOrgScopedAssetContentUrl,
  fetchAssetObjectBytes,
  getSignedAssetUrl,
  putAssetObject,
} from "@/services/asset-storage";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function createReferenceAsset(input: {
  organisationId: string;
  userId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<{ id: string; url: string; storageKey: string; mimeType: string }> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");
  }
  if (input.bytes.length > 8 * 1024 * 1024) {
    throw new Error("Image is too large. Keep uploads under 8MB.");
  }

  const storageKey = buildAssetStorageKey({
    organisationId: input.organisationId,
    kind: "reference",
    filename: input.filename || "reference.png",
  });
  const put = await putAssetObject({
    organisationId: input.organisationId,
    storageKey,
    bytes: input.bytes,
    mimeType: input.mimeType,
  });

  const asset = await prisma.asset.create({
    data: {
      organisationId: input.organisationId,
      // Opaque private locator — clients must use signedUrl / content route.
      url: put.url,
      storageKey: put.storageKey,
      mimeType: input.mimeType,
      kind: "reference",
      createdByUserId: input.userId,
      costCents: 0,
    },
  });

  const signed = buildOrgScopedAssetContentUrl({
    organisationId: input.organisationId,
    assetId: asset.id,
  });

  return {
    id: asset.id,
    url: signed.url,
    storageKey: put.storageKey,
    mimeType: asset.mimeType,
  };
}

export async function createGeneratedAsset(input: {
  organisationId: string;
  userId?: string | null;
  bytes: Buffer;
  mimeType: string;
  prompt: string;
  provider: string;
  model: string;
  costCents: number;
  width: number;
  height: number;
  derivedFromAssetId?: string | null;
}): Promise<{ id: string; url: string }> {
  const storageKey = buildAssetStorageKey({
    organisationId: input.organisationId,
    kind: "generated",
    filename: `generated.${input.mimeType.includes("jpeg") ? "jpg" : "png"}`,
  });
  const put = await putAssetObject({
    organisationId: input.organisationId,
    storageKey,
    bytes: input.bytes,
    mimeType: input.mimeType,
  });

  const asset = await prisma.asset.create({
    data: {
      organisationId: input.organisationId,
      url: put.url,
      storageKey: put.storageKey,
      mimeType: input.mimeType,
      kind: "generated",
      prompt: input.prompt,
      provider: input.provider,
      model: input.model,
      costCents: input.costCents,
      width: input.width,
      height: input.height,
      createdByUserId: input.userId ?? null,
      derivedFromAssetId: input.derivedFromAssetId ?? null,
    },
  });

  const signed = buildOrgScopedAssetContentUrl({
    organisationId: input.organisationId,
    assetId: asset.id,
  });

  return { id: asset.id, url: signed.url };
}

export async function getOrgAsset(input: {
  organisationId: string;
  assetId: string;
}): Promise<{
  id: string;
  /** Always a signed/read-time URL — never the raw private blob locator. */
  url: string;
  signedUrl: string;
  mimeType: string;
  kind: string;
  prompt: string | null;
  costCents: number;
  provider: string | null;
  model: string | null;
  derivedFromAssetId: string | null;
  storageKey: string;
  expiresAt: string;
} | null> {
  const asset = await prisma.asset.findFirst({
    where: { id: input.assetId, organisationId: input.organisationId },
  });
  if (!asset) return null;
  const signed = await getSignedAssetUrl({
    organisationId: input.organisationId,
    assetId: asset.id,
    storageKey: asset.storageKey,
    storedUrl: asset.url,
  });
  return {
    id: asset.id,
    url: signed.url,
    signedUrl: signed.url,
    mimeType: asset.mimeType,
    kind: asset.kind,
    prompt: asset.prompt,
    costCents: asset.costCents,
    provider: asset.provider,
    model: asset.model,
    derivedFromAssetId: asset.derivedFromAssetId,
    storageKey: asset.storageKey,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

export async function loadAssetBytes(input: {
  organisationId: string;
  assetId: string;
}): Promise<{ bytes: Buffer; mimeType: string; assetId: string } | null> {
  const asset = await prisma.asset.findFirst({
    where: { id: input.assetId, organisationId: input.organisationId },
  });
  if (!asset) return null;
  const bytes = await fetchAssetObjectBytes({
    organisationId: input.organisationId,
    storageKey: asset.storageKey,
    storedUrl: asset.url,
  });
  return {
    bytes,
    mimeType: asset.mimeType,
    assetId: asset.id,
  };
}

export { AssetStorageNotConfiguredError };
export type AssetCreateMeta = Prisma.AssetCreateInput;
