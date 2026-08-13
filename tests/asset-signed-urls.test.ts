import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildAssetStorageKey,
  buildOrgScopedAssetContentUrl,
  verifyOrgScopedAssetContentUrl,
} from "@/services/asset-storage";
import { resetEnvCache } from "@/lib/env";

describe("private asset URLs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("builds org-scoped storage keys", () => {
    const key = buildAssetStorageKey({
      organisationId: "org_abc",
      kind: "reference",
      filename: "shot.png",
    });
    expect(key.startsWith("org/org_abc/reference/")).toBe(true);
    expect(key).toContain("shot.png");
  });

  it("mints a signed content URL that verifies for the same org/asset", () => {
    const { url, expiresAt } = buildOrgScopedAssetContentUrl({
      organisationId: "org_1",
      assetId: "asset_1",
      expiresInSeconds: 300,
    });
    expect(url.startsWith("/api/assets/asset_1/content?")).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const parsed = new URL(url, "http://localhost");
    expect(
      verifyOrgScopedAssetContentUrl({
        organisationId: "org_1",
        assetId: "asset_1",
        exp: parsed.searchParams.get("exp"),
        sig: parsed.searchParams.get("sig"),
      }),
    ).toBe(true);
  });

  it("rejects cross-org or tampered signed content URLs", () => {
    const { url } = buildOrgScopedAssetContentUrl({
      organisationId: "org_1",
      assetId: "asset_1",
      expiresInSeconds: 300,
    });
    const parsed = new URL(url, "http://localhost");
    expect(
      verifyOrgScopedAssetContentUrl({
        organisationId: "org_OTHER",
        assetId: "asset_1",
        exp: parsed.searchParams.get("exp"),
        sig: parsed.searchParams.get("sig"),
      }),
    ).toBe(false);
    expect(
      verifyOrgScopedAssetContentUrl({
        organisationId: "org_1",
        assetId: "asset_1",
        exp: parsed.searchParams.get("exp"),
        sig: "tampered",
      }),
    ).toBe(false);
  });

  it("does not return a bare private blob URL from getSignedAssetUrl for vercel_blob", async () => {
    vi.stubEnv("ASSET_STORAGE", "vercel_blob");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    resetEnvCache();
    const { getSignedAssetUrl } = await import("@/services/asset-storage");
    const signed = await getSignedAssetUrl({
      organisationId: "org_1",
      assetId: "asset_1",
      storageKey: "org/org_1/generated/x.png",
      storedUrl: "https://store.private.blob.vercel-storage.com/org/org_1/generated/x.png",
    });
    expect(signed.url).toContain("/api/assets/asset_1/content");
    expect(signed.url).not.toContain("blob.vercel-storage.com");
  });
});
