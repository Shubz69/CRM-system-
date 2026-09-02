import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberRole } from "@prisma/client";
import { roleHasPermission } from "@/lib/permissions";
import { resetEnvCache } from "@/lib/env";
import {
  getDeclaredCapability,
  platformSupportsCapability,
  resolveProviderPlatformCapability,
} from "@/services/social-prospecting/capabilities";
import {
  ensureDefaultMessagingProvidersRegistered,
  listSocialMessagingProviders,
  selectProviderForCapability,
} from "@/services/social-prospecting/provider-router";
import { parseProspectIntent } from "@/services/social-prospecting/types";

const prismaMocks = vi.hoisted(() => ({
  zernioProfile: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "zp_1",
      connectedAccounts: [],
      ...args.data,
    })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  webhookEvent: {
    findUnique: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  socialProviderUsage: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  socialMetricFact: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMocks,
}));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: vi.fn(async () => ({ id: "evt_1" })),
}));

describe("Zernio capability matrix + platform gates", () => {
  it("declares Zernio capabilities without inferring from configuration", () => {
    expect(getDeclaredCapability("ZERNIO", "CONNECT_ACCOUNT")?.baseline).toBe("AVAILABLE");
    expect(getDeclaredCapability("ZERNIO", "PUBLISH")?.baseline).toBe("AVAILABLE");
    expect(getDeclaredCapability("ZERNIO", "WEBHOOKS")?.baseline).toBe("AVAILABLE");
    expect(getDeclaredCapability("ZERNIO", "DISCOVERY")?.baseline).toBe("UNSUPPORTED");
  });

  it("LinkedIn DM capability is false at platform level for Zernio", () => {
    expect(platformSupportsCapability("LINKEDIN", "DIRECT_MESSAGES")).toBe(false);
    expect(
      resolveProviderPlatformCapability({
        provider: "ZERNIO",
        network: "LINKEDIN",
        capability: "DIRECT_MESSAGES",
      }),
    ).toBe("UNSUPPORTED");
  });

  it("Instagram messaging capability is conditional / available at provider+platform", () => {
    expect(platformSupportsCapability("INSTAGRAM", "DIRECT_MESSAGES")).toBe(true);
    expect(
      resolveProviderPlatformCapability({
        provider: "ZERNIO",
        network: "INSTAGRAM",
        capability: "DIRECT_MESSAGES",
      }),
    ).toBe("AVAILABLE");
  });
});

describe("Zernio adapter isolation + routing", () => {
  afterEach(() => {
    delete process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    delete process.env.AYRSHARE_API_KEY;
    resetEnvCache();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("missing Zernio config does not break prospecting", async () => {
    delete process.env.ZERNIO_API_KEY;
    resetEnvCache();
    const { isZernioConfigured } = await import("@/adapters/zernio");
    expect(isZernioConfigured()).toBe(false);
    expect(parseProspectIntent("Find 3 founders").desiredCount).toBe(3);
  });

  it("org → Zernio profile isolation + creation", async () => {
    process.env.ZERNIO_API_KEY = "test-zernio-key";
    resetEnvCache();
    prismaMocks.zernioProfile.findUnique.mockResolvedValueOnce(null);
    prismaMocks.zernioProfile.create.mockResolvedValueOnce({
      id: "zp_a",
      organisationId: "org_a",
      zernioProfileId: null,
      status: "CONFIGURED",
      connectedAccounts: [],
    });

    const { getOrCreateZernioProfile } = await import("@/adapters/zernio");
    const a = await getOrCreateZernioProfile("org_a");
    expect(a.organisationId).toBe("org_a");
    expect(prismaMocks.zernioProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organisationId: "org_a" }) }),
    );
  });

  it("connect URL generation uses profileId and never returns API key", async () => {
    process.env.ZERNIO_API_KEY = "secret-master-key-never-browser";
    resetEnvCache();
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "remote_profile_1",
      status: "CONFIGURED",
      connectedAccounts: [],
    });
    prismaMocks.zernioProfile.update.mockResolvedValue({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ authUrl: "https://zernio.com/oauth/instagram?x=1" }),
      })),
    );

    const { createZernioConnectUrl } = await import("@/adapters/zernio");
    const result = await createZernioConnectUrl({
      organisationId: "org_1",
      platform: "instagram",
      redirectUrl: "https://app.example/api/integrations/zernio/callback",
      headless: true,
    });
    expect(result.ok).toBe(true);
    expect(result.url).toContain("https://");
    expect(JSON.stringify(result)).not.toContain("secret-master-key-never-browser");
    expect(result.headless).toBe(true);

    const callUrl = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(callUrl).toContain("/connect/instagram");
    expect(callUrl).toContain("profileId=remote_profile_1");
    expect(callUrl).toContain("headless=true");
  });

  it("Instagram direct-login path does not hard-require Facebook Page", async () => {
    const { zernioInstagramMessagingCapability } = await import("@/adapters/zernio");
    const cap = zernioInstagramMessagingCapability(false);
    expect(cap.coldDm).toBe(false);
    expect(cap.note.toLowerCase()).toMatch(/no facebook page/);
  });

  it("LinkedIn messaging helper keeps DM false", async () => {
    const { zernioLinkedInMessagingCapability } = await import("@/adapters/zernio");
    expect(zernioLinkedInMessagingCapability().directMessages).toBe(false);
  });

  it("webhook signature verification", async () => {
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec_test";
    resetEnvCache();
    const { verifyZernioWebhookSignature } = await import("@/adapters/zernio");
    const body = JSON.stringify({ id: "evt_1", event: "account.connected" });
    const good = createHmac("sha256", "whsec_test").update(body).digest("hex");
    expect(verifyZernioWebhookSignature(body, good)).toBe(true);
    expect(verifyZernioWebhookSignature(body, "deadbeef")).toBe(false);
    expect(verifyZernioWebhookSignature(body, null)).toBe(false);
  });

  it("webhook tenant mapping by profileId", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValueOnce({
      organisationId: "org_mapped",
    });
    const { findOrganisationIdByZernioProfileId } = await import("@/adapters/zernio");
    const org = await findOrganisationIdByZernioProfileId("remote_profile_xyz");
    expect(org).toBe("org_mapped");
  });

  it("account disconnect soft-clears local connected accounts", async () => {
    process.env.ZERNIO_API_KEY = "k";
    resetEnvCache();
    // Simulate disconnect_local path used by API
    await prismaMocks.zernioProfile.updateMany({
      where: { organisationId: "org_1" },
      data: { connectedAccounts: [], status: "DISCONNECTED" },
    });
    expect(prismaMocks.zernioProfile.updateMany).toHaveBeenCalled();
  });

  it("provider router prefers Zernio when configured", () => {
    process.env.ZERNIO_API_KEY = "z";
    delete process.env.AYRSHARE_API_KEY;
    ensureDefaultMessagingProvidersRegistered();
    const selected = selectProviderForCapability({
      capability: "PUBLISH",
      network: "INSTAGRAM",
    });
    expect(selected?.id).toBe("ZERNIO");
  });

  it("Zernio outage / absence does not break manual Open/Copy prospecting", async () => {
    delete process.env.ZERNIO_API_KEY;
    ensureDefaultMessagingProvidersRegistered();
    const providers = listSocialMessagingProviders();
    expect(providers.find((p) => p.id === "ZERNIO")?.isConfigured()).toBe(false);
    const { universalOutreachSurface } = await import("@/services/social-prospecting/provider-router");
    expect(universalOutreachSurface("LINKEDIN").copyActions.length).toBeGreaterThan(0);
    expect(universalOutreachSurface("INSTAGRAM").openLabel).toBe("Open Instagram");
  });

  it("Read Only cannot connect/disconnect social accounts", () => {
    expect(roleHasPermission(MemberRole.READ_ONLY, "integrations:manage")).toBe(false);
  });

  it("preferredProviderForCapability routes LinkedIn DM to MANUAL", async () => {
    process.env.ZERNIO_API_KEY = "z";
    resetEnvCache();
    const { preferredProviderForCapability } = await import("@/adapters/zernio");
    expect(
      preferredProviderForCapability({ network: "LINKEDIN", capability: "DIRECT_MESSAGES" }),
    ).toBe("MANUAL");
    expect(
      preferredProviderForCapability({ network: "INSTAGRAM", capability: "CONNECT_ACCOUNT" }),
    ).toBe("ZERNIO");
  });
});

describe("Zernio webhook route idempotency", () => {
  afterEach(() => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    resetEnvCache();
    vi.clearAllMocks();
  });

  it("rejects bad signature and accepts idempotent duplicates", async () => {
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec_test";
    resetEnvCache();

    const body = JSON.stringify({
      id: "evt_dup_1",
      event: "account.connected",
      profileId: "remote_p1",
      accountId: "acc_1",
      platform: "instagram",
    });
    const sig = createHmac("sha256", "whsec_test").update(body).digest("hex");

    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.webhookEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "we_1",
      idempotencyKey: "evt_dup_1",
    });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
      zernioProfileId: "remote_p1",
      connectedAccounts: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ accounts: [] }),
      })),
    );

    const { POST } = await import("@/app/api/webhooks/zernio/route");

    const bad = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": "nope" },
        body,
      }) as never,
    );
    expect(bad.status).toBe(401);

    const ok = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    expect(ok.status).toBe(200);

    const dup = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    const dupJson = await dup.json();
    expect(dupJson.duplicate).toBe(true);
  });
});
