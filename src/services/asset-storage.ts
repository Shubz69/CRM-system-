import { createHash, createHmac } from "crypto";
import { getEnv } from "@/lib/env";

export class AssetStorageNotConfiguredError extends Error {
  readonly code = "ASSET_STORAGE_NOT_CONFIGURED";
  constructor(message = "Asset object storage is not configured") {
    super(message);
    this.name = "AssetStorageNotConfiguredError";
  }
}

export type PutAssetInput = {
  organisationId: string;
  storageKey: string;
  bytes: Buffer;
  mimeType: string;
};

export type PutAssetResult = {
  url: string;
  storageKey: string;
  provider: "vercel_blob" | "s3";
};

export type SignedUrlResult = {
  url: string;
  expiresAt: Date;
};

function requireStorageMode(): "vercel_blob" | "s3" {
  const mode = (getEnv().ASSET_STORAGE || "none").toLowerCase();
  if (mode === "vercel_blob" || mode === "blob") return "vercel_blob";
  if (mode === "s3") return "s3";
  throw new AssetStorageNotConfiguredError(
    'Asset storage is not configured. Set ASSET_STORAGE=vercel_blob (with BLOB_READ_WRITE_TOKEN) or ASSET_STORAGE=s3 (with S3_* credentials).',
  );
}

async function putVercelBlob(input: PutAssetInput): Promise<PutAssetResult> {
  const token = getEnv().BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new AssetStorageNotConfiguredError(
      "ASSET_STORAGE=vercel_blob requires BLOB_READ_WRITE_TOKEN",
    );
  }
  const pathname = input.storageKey.replace(/^\/+/, "");
  const res = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-version": "7",
      "x-content-type": input.mimeType,
      "x-add-random-suffix": "0",
    },
    body: new Uint8Array(input.bytes),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel Blob upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { url?: string; pathname?: string };
  if (!json.url) throw new Error("Vercel Blob upload returned no URL");
  return { url: json.url, storageKey: pathname, provider: "vercel_blob" };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

async function putS3(input: PutAssetInput): Promise<PutAssetResult> {
  const env = getEnv();
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION || "us-east-1";
  const accessKey = env.S3_ACCESS_KEY_ID;
  const secretKey = env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKey || !secretKey) {
    throw new AssetStorageNotConfiguredError(
      "ASSET_STORAGE=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY",
    );
  }
  const endpoint = env.S3_ENDPOINT?.replace(/\/$/, "");
  const key = input.storageKey.replace(/^\/+/, "");
  const host = endpoint
    ? new URL(endpoint).host
    : `${bucket}.s3.${region}.amazonaws.com`;
  const path = endpoint ? `/${bucket}/${key}` : `/${key}`;
  const url = endpoint
    ? `${endpoint}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

  const { amz, date } = amzDate();
  const payloadHash = sha256Hex(input.bytes);
  const canonicalHeaders =
    `content-type:${input.mimeType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amz}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": input.mimeType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amz,
      Host: host,
    },
    body: new Uint8Array(input.bytes),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { url, storageKey: key, provider: "s3" };
}

export async function putAssetObject(input: PutAssetInput): Promise<PutAssetResult> {
  const mode = requireStorageMode();
  if (mode === "vercel_blob") return putVercelBlob(input);
  return putS3(input);
}

/**
 * Org-scoped signed/read URL. For Vercel Blob returns the stored URL (token-gated at edge when private).
 * For S3 returns a short-lived presigned GET.
 */
export async function getSignedAssetUrl(input: {
  organisationId: string;
  storageKey: string;
  storedUrl: string;
  expiresInSeconds?: number;
}): Promise<SignedUrlResult> {
  const expectedPrefix = `org/${input.organisationId}/`;
  if (!input.storageKey.startsWith(expectedPrefix)) {
    throw new Error("Asset storage key is outside this organisation");
  }

  const mode = requireStorageMode();
  const expiresIn = input.expiresInSeconds ?? 15 * 60;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  if (mode === "vercel_blob") {
    return { url: input.storedUrl, expiresAt };
  }

  const env = getEnv();
  const bucket = env.S3_BUCKET!;
  const region = env.S3_REGION || "us-east-1";
  const accessKey = env.S3_ACCESS_KEY_ID!;
  const secretKey = env.S3_SECRET_ACCESS_KEY!;
  const endpoint = env.S3_ENDPOINT?.replace(/\/$/, "");
  const key = input.storageKey.replace(/^\/+/, "");
  const host = endpoint
    ? new URL(endpoint).host
    : `${bucket}.s3.${region}.amazonaws.com`;
  const path = endpoint ? `/${bucket}/${key}` : `/${key}`;
  const { amz, date } = amzDate();
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const query =
    `X-Amz-Algorithm=AWS4-HMAC-SHA256` +
    `&X-Amz-Credential=${encodeURIComponent(`${accessKey}/${credentialScope}`)}` +
    `&X-Amz-Date=${amz}` +
    `&X-Amz-Expires=${expiresIn}` +
    `&X-Amz-SignedHeaders=host`;
  const canonicalRequest = ["GET", path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join(
    "\n",
  );
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const base = endpoint
    ? `${endpoint}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return {
    url: `${base}?${query}&X-Amz-Signature=${signature}`,
    expiresAt,
  };
}

export function buildAssetStorageKey(input: {
  organisationId: string;
  kind: "reference" | "generated";
  filename: string;
}): string {
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `org/${input.organisationId}/${input.kind}/${Date.now()}-${safe}`;
}
