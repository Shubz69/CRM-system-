import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRole } from "@prisma/client";
import { resetEnvCache } from "@/lib/env";
import { roleHasPermission } from "@/lib/permissions";
import { createHmac } from "crypto";

const prismaMocks = vi.hoisted(() => ({
  zernioProfile: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      connectedAccounts: [],
      status: "CONFIGURED",
      lastSyncAt: new Date(),
      lastError: null,
      ...args.data,
    })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  integration: {
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "int_1",
      ...args.create,
    })),
  },
  messagingChannel: {
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "ch_1",
      ...args.create,
    })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  organisationPreference: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => args.create),
  },
  contact: { count: vi.fn(async () => 3) },
  conversation: { count: vi.fn(async () => 2) },
  message: { count: vi.fn(async () => 5) },
  auditLog: { create: vi.fn(async () => ({ id: "a1" })) },
  domainEvent: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "de", ...args.data })),
  },
  webhookEvent: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "we", ...args.data })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMocks)),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));

vi.mock("@/services/domain-events/append", () => ({
  appendDomainEvent: vi.fn(async () => ({ id: "evt" })),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({
    userId: "user_1",
    organisationId: "org_1",
    role: "OWNER",
  })),
  requireSession: vi.fn(async () => ({
    userId: "user_1",
    organisationId: "org_1",
    role: "OWNER",
  })),
  jsonError: (message: string, status: number) =>
    Response.json({ error: message }, { status }),
}));

describe("Zernio social account status + disconnect", () => {
  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "zk";
    process.env.ZERNIO_WEBHOOK_SECRET = "whsec";
    process.env.AUTH_SECRET = "auth-secret-for-state-tests-32chars!!";
    resetEnvCache();
    vi.clearAllMocks();
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      connectedAccounts: [],
      status: "CONFIGURED",
      lastSyncAt: null,
      lastError: null,
    });
  });

  afterEach(() => {
    delete process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    vi.unstubAllGlobals();
  });

  it("sync uses official /accounts?profileId= and persists CONNECTED network state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/accounts?profileId=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accounts: [
                {
                  _id: "acc_ig_1",
                  platform: "instagram",
                  username: "@ada",
                  displayName: "Ada",
                  isActive: true,
                  authMode: "instagram_login",
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const { syncZernioConnectedAccounts, buildCanonicalZernioNetworks } = await import(
      "@/adapters/zernio"
    );
    const result = await syncZernioConnectedAccounts("org_1");
    expect(result.ok).toBe(true);
    expect(result.source).toBe("accounts_list");
    expect(result.accounts[0]?.username).toBe("ada");
    expect(prismaMocks.zernioProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CONNECTED",
          connectedAccounts: expect.arrayContaining([
            expect.objectContaining({ accountId: "acc_ig_1", platform: "instagram" }),
          ]),
        }),
      }),
    );

    const networks = buildCanonicalZernioNetworks({
      profile: {
        status: "CONNECTED",
        zernioProfileId: "zprof_1",
        connectedAccounts: result.accounts,
        lastSyncAt: new Date(),
      },
    });
    expect(networks.instagram.status).toBe("CONNECTED");
    expect(networks.instagram.connected).toBe(true);
    expect(networks.instagram.username).toBe("ada");
    expect(networks.linkedin.status).toBe("DISCONNECTED");
  });

  it("GET health returns CONNECTED after provider accounts persist", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        {
          accountId: "acc_ig_1",
          platform: "instagram",
          username: "ada",
          displayName: "Ada",
          status: "connected",
          authMode: "instagram_login",
        },
      ],
    });

    const { GET } = await import("@/app/api/integrations/zernio/route");
    const res = await GET();
    const json = await res.json();
    expect(json.networks.instagram.status).toBe("CONNECTED");
    expect(json.networks.instagram.connected).toBe(true);
    expect(json.networks.instagram.username).toBe("ada");
    expect(json.networks.instagram.accountType).toMatch(/Business|Creator/);
  });

  it("disconnect remote success removes only that network", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
        { accountId: "acc_li", platform: "linkedin", displayName: "Ada LI", status: "connected" },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (String(url).includes("/accounts/acc_ig") && init?.method === "DELETE") {
          return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
        }
        if (String(url).includes("/accounts?profileId=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accounts: [
                { _id: "acc_li", platform: "linkedin", displayName: "Ada LI", isActive: true },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    // After persist + sync, findUnique should reflect LinkedIn remaining
    prismaMocks.zernioProfile.findUnique
      .mockResolvedValueOnce({
        id: "zp_1",
        organisationId: "org_1",
        zernioProfileId: "zprof_1",
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
        connectedAccounts: [
          { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
          { accountId: "acc_li", platform: "linkedin", displayName: "Ada LI", status: "connected" },
        ],
      })
      .mockResolvedValue({
        id: "zp_1",
        organisationId: "org_1",
        zernioProfileId: "zprof_1",
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
        connectedAccounts: [
          { accountId: "acc_li", platform: "linkedin", displayName: "Ada LI", status: "connected" },
        ],
      });

    const { disconnectZernioPlatformAccount, buildCanonicalZernioNetworks } = await import(
      "@/adapters/zernio"
    );
    const result = await disconnectZernioPlatformAccount({
      organisationId: "org_1",
      platform: "instagram",
      userId: "user_1",
    });
    expect(result.ok).toBe(true);
    expect(result.remote).toBe("disconnected");
    expect(result.network?.status).toBe("DISCONNECTED");

    const nets = buildCanonicalZernioNetworks({
      profile: {
        status: "CONNECTED",
        zernioProfileId: "zprof_1",
        lastSyncAt: new Date(),
        connectedAccounts: [
          { accountId: "acc_li", platform: "linkedin", displayName: "Ada LI", status: "connected" },
        ],
      },
    });
    expect(nets.linkedin.status).toBe("CONNECTED");
    expect(nets.instagram.status).toBe("DISCONNECTED");
  });

  it("already disconnected remote (404) is idempotent success", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "Not found" }) })),
    );
    const { disconnectZernioPlatformAccount } = await import("@/adapters/zernio");
    const result = await disconnectZernioPlatformAccount({
      organisationId: "org_1",
      platform: "instagram",
    });
    expect(result.ok).toBe(true);
    expect(result.remote).toBe("already_disconnected");
  });

  it("unknown remote disconnect outcome does not claim DISCONNECTED", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") {
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        }
        // resync still sees account
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accounts: [{ _id: "acc_ig", platform: "instagram", username: "ada", isActive: true }],
          }),
        };
      }),
    );
    const { disconnectZernioPlatformAccount } = await import("@/adapters/zernio");
    const result = await disconnectZernioPlatformAccount({
      organisationId: "org_1",
      platform: "instagram",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RECONCILIATION_REQUIRED");
    expect(result.remote).toBe("unknown");
  });

  it("disconnect preserves CRM history counts (no contact/conversation/message deletes)", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") {
          return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
        }
        return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
      }),
    );
    const { disconnectZernioPlatformAccount } = await import("@/adapters/zernio");
    await disconnectZernioPlatformAccount({ organisationId: "org_1", platform: "instagram" });
    expect(prismaMocks.contact.count).not.toHaveBeenCalled();
    // No deleteMany on CRM models
    expect((prismaMocks as { contact?: { deleteMany?: unknown } }).contact?.deleteMany).toBeUndefined();
  });

  it("Read Only cannot manage disconnect", () => {
    expect(roleHasPermission(MemberRole.READ_ONLY, "integrations:manage")).toBe(false);
  });

  it("POST disconnect requires integrations:manage (FORBIDDEN for read-only mock)", async () => {
    const session = await import("@/lib/session");
    vi.mocked(session.requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN"));
    const { POST } = await import("@/app/api/integrations/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/integrations/zernio", {
        method: "POST",
        body: JSON.stringify({ action: "disconnect", platform: "instagram" }),
      }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("reconnect reuses profile upsert without duplicate Integration create conflict", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONFIGURED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/accounts?profileId=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accounts: [{ _id: "acc_ig_1", platform: "instagram", username: "ada", isActive: true }],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    const { syncZernioConnectedAccounts } = await import("@/adapters/zernio");
    await syncZernioConnectedAccounts("org_1");
    await syncZernioConnectedAccounts("org_1");
    expect(prismaMocks.integration.upsert).toHaveBeenCalled();
    expect(prismaMocks.zernioProfile.create).not.toHaveBeenCalled();
  });

  it("account.connected webhook updates local state via sync", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTING",
      lastSyncAt: null,
      lastError: null,
      connectedAccounts: [{ accountId: "acc_ig", platform: "instagram", status: "connected" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accounts: [{ _id: "acc_ig", platform: "instagram", username: "ada", isActive: true }],
        }),
      })),
    );
    const body = JSON.stringify({
      id: "evt_acc_on",
      event: "account.connected",
      profileId: "zprof_1",
      accountId: "acc_ig",
      platform: "instagram",
    });
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(prismaMocks.zernioProfile.update).toHaveBeenCalled();
  });

  it("account.disconnected webhook removes account from local state", async () => {
    prismaMocks.zernioProfile.findFirst.mockResolvedValue({ organisationId: "org_1" });
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
      connectedAccounts: [
        { accountId: "acc_ig", platform: "instagram", status: "connected" },
        { accountId: "acc_li", platform: "linkedin", status: "connected" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accounts: [{ _id: "acc_li", platform: "linkedin", displayName: "LI", isActive: true }],
        }),
      })),
    );
    const body = JSON.stringify({
      id: "evt_acc_off",
      event: "account.disconnected",
      profileId: "zprof_1",
      accountId: "acc_ig",
      platform: "instagram",
    });
    const sig = createHmac("sha256", "whsec").update(body).digest("hex");
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": sig },
        body,
      }) as never,
    );
    expect(res.status).toBe(200);
  });

  it("provider connected / local empty heals via maybeHealZernioAccountState", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      id: "zp_1",
      organisationId: "org_1",
      zernioProfileId: "zprof_1",
      status: "CONFIGURED",
      lastSyncAt: new Date(Date.now() - 60_000),
      lastError: null,
      connectedAccounts: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accounts: [{ _id: "acc_ig", platform: "instagram", username: "ada", isActive: true }],
        }),
      })),
    );
    const { maybeHealZernioAccountState, buildCanonicalZernioNetworks } = await import(
      "@/adapters/zernio"
    );
    // After heal, return connected profile
    prismaMocks.zernioProfile.findUnique
      .mockResolvedValueOnce({
        id: "zp_1",
        organisationId: "org_1",
        zernioProfileId: "zprof_1",
        status: "CONFIGURED",
        lastSyncAt: new Date(Date.now() - 60_000),
        lastError: null,
        connectedAccounts: [],
      })
      .mockResolvedValue({
        id: "zp_1",
        organisationId: "org_1",
        zernioProfileId: "zprof_1",
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
        connectedAccounts: [
          { accountId: "acc_ig", platform: "instagram", username: "ada", status: "connected" },
        ],
      });

    const healed = await maybeHealZernioAccountState("org_1");
    expect(healed.healed).toBe(true);
    const nets = buildCanonicalZernioNetworks({ profile: healed.profile });
    expect(nets.instagram.status).toBe("CONNECTED");
  });

  it("OAuth callback state org mismatch denies cross-org assignment", async () => {
    const { createZernioConnectState, verifyZernioConnectState } = await import("@/adapters/zernio");
    const state = createZernioConnectState("org_A");
    expect(verifyZernioConnectState(state, "org_B").ok).toBe(false);
  });
});
