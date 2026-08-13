import { createHash, createHmac, timingSafeEqual } from "crypto";
import { getAuthSecret, getEnv } from "@/lib/env";

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
  /** Opaque object locator — never treat as a public browser URL when storage is private. */
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

function blobAuthToken(): string {
  const env = getEnv();
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  if (oidc) return oidc;
  if (env.BLOB_READ_WRITE_TOKEN) return env.BLOB_READ_WRITE_TOKEN;
  throw new AssetStorageNotConfiguredError(
    "ASSET_STORAGE=vercel_blob requires BLOB_READ_WRITE_TOKEN (or VERCEL_OIDC_TOKEN on Vercel)",
  );
}

async function putVercelBlob(input: PutAssetInput): Promise<PutAssetResult> {
  const token = blobAuthToken();
  const pathname = input.storageKey.replace(/^\/+/, "");
  const res = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-version": "7",
      "x-content-type": input.mimeType,
      "x-add-random-suffix": "0",
      // Private Blob store — never upload as public.
      "x-vercel-blob-access": "private",
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
 * Fetch private object bytes. Vercel private Blob requires Authorization;
 * S3 uses a short-lived presigned GET.
 */
export async function fetchAssetObjectBytes(input: {
  organisationId: string;
  storageKey: string;
  storedUrl: string;
}): Promise<Buffer> {
  assertOrgStorageKey(input.organisationId, input.storageKey);
  const mode = requireStorageMode();

  if (mode === "vercel_blob") {
    const token = blobAuthToken();
    const res = await fetch(input.storedUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Could not read private blob (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const signed = await getS3SignedGetUrl({
    organisationId: input.organisationId,
    storageKey: input.storageKey,
    expiresInSeconds: 60,
  });
  const res = await fetch(signed.url);
  if (!res.ok) {
    throw new Error(`Could not read S3 object (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function assertOrgStorageKey(organisationId: string, storageKey: string): void {
  const expectedPrefix = `org/${organisationId}/`;
  if (!storageKey.startsWith(expectedPrefix)) {
    throw new Error("Asset storage key is outside this organisation");
  }
}

/** Time-limited, org-scoped content URL served by this app (never a raw private blob URL). */
export function buildOrgScopedAssetContentUrl(input: {
  organisationId: string;
  assetId: string;
  expiresInSeconds?: number;
  absolute?: boolean;
}): SignedUrlResult {
  const expiresIn = input.expiresInSeconds ?? 15 * 60;
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${input.organisationId}.${input.assetId}.${exp}`;
  const sig = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const path =
    `/api/assets/${encodeURIComponent(input.assetId)}/content` +
    `?org=${encodeURIComponent(input.organisationId)}` +
    `&exp=${exp}` +
    `&sig=${sig}`;
  const base = getEnv().APP_URL?.replace(/\/$/, "") || "";
  return {
    url: input.absolute && base ? `${base}${path}` : path,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyOrgScopedAssetContentUrl(input: {
  organisationId: string;
  assetId: string;
  exp: string | null;
  sig: string | null;
}): boolean {
  if (!input.exp || !input.sig) return false;
  const exp = Number(input.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const payload = `${input.organisationId}.${input.assetId}.${exp}`;
  const expected = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(input.sig);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function getS3SignedGetUrl(input: {
  organisationId: string;
  storageKey: string;
  expiresInSeconds: number;
}): Promise<SignedUrlResult> {
  assertOrgStorageKey(input.organisationId, input.storageKey);
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
    `&X-Amz-Expires=${input.expiresInSeconds}` +
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
    expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
  };
}

/**
 * Org-scoped signed/read URL minted at read time.
 * - Vercel private Blob: app content URL with HMAC (browser never gets a bare private blob URL)
 * - S3: short-lived presigned GET
 */
export async function getSignedAssetUrl(input: {
  organisationId: string;
  assetId: string;
  storageKey: string;
  storedUrl: string;
  expiresInSeconds?: number;
  absolute?: boolean;
}): Promise<SignedUrlResult> {
  assertOrgStorageKey(input.organisationId, input.storageKey);
  const mode = requireStorageMode();
  const expiresIn = input.expiresInSeconds ?? 15 * 60;

  if (mode === "vercel_blob") {
    return buildOrgScopedAssetContentUrl({
      organisationId: input.organisationId,
      assetId: input.assetId,
      expiresInSeconds: expiresIn,
      absolute: input.absolute,
    });
  }

  return getS3SignedGetUrl({
    organisationId: input.organisationId,
    storageKey: input.storageKey,
    expiresInSeconds: expiresIn,
  });
}

export function buildAssetStorageKey(input: {
  organisationId: string;
  kind: "reference" | "generated";
  filename: string;
}): string {
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `org/${input.organisationId}/${input.kind}/${Date.now()}-${safe}`;
}
