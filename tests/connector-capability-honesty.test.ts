/**
 * Zernio/Ayrshare ACTIVE connections must not be misreported as
 * native-OAuth SCOPE_REQUIRED / AUTH_REQUIRED ghosts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCapabilityStatus, ConnectorConnectionStatus } from "@prisma/client";

const socialFindMany = vi.fn();
const integrationFindFirst = vi.fn();
const capabilityUpsert = vi.fn();
const capabilityDeleteMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: (...a: unknown[]) => socialFindMany(...a) },
    integration: { findFirst: (...a: unknown[]) => integrationFindFirst(...a) },
    connectorCapabilityState: {
      upsert: (...a: unknown[]) => capabilityUpsert(...a),
      deleteMany: (...a: unknown[]) => capabilityDeleteMany(...a),
    },
  },
}));

import {
  connectionGrantsPublish,
  evaluateOrganisationConnectors,
  pickSocialConnection,
  socialConnectionViaProvider,
} from "@/services/connectors";

describe("social connection via-provider helpers", () => {
  it("detects Zernio from external id, scopes, and metadata", () => {
    expect(
      socialConnectionViaProvider({
        externalAccountId: "zernio:acc_1",
        scopes: ["zernio:publish"],
        metadata: { provider: "ZERNIO", zernioAccountId: "acc_1" },
      }),
    ).toBe("ZERNIO");
    expect(
      socialConnectionViaProvider({
        externalAccountId: "ayrshare:acc_2",
        scopes: ["ayrshare:publish"],
      }),
    ).toBe("AYRSHARE");
    expect(
      socialConnectionViaProvider({
        externalAccountId: "native-ig",
        scopes: ["instagram_business_content_publish"],
      }),
    ).toBe("NATIVE");
  });

  it("treats capabilities.publish as granted even without native scopes", () => {
    expect(connectionGrantsPublish({ capabilities: { publish: true }, scopes: [] })).toBe(true);
    expect(connectionGrantsPublish({ capabilities: {}, scopes: [] })).toBe(false);
    expect(connectionGrantsPublish({ scopes: ["w_member_social"] })).toBe(true);
  });

  it("prefers ACTIVE over stale sibling connections", () => {
    const picked = pickSocialConnection(
      [
        {
          platform: "LINKEDIN",
          status: "ERROR",
          lastSyncedAt: new Date("2026-09-01"),
          updatedAt: new Date("2026-09-01"),
        },
        {
          platform: "LINKEDIN",
          status: "ACTIVE",
          lastSyncedAt: new Date("2026-09-14"),
          updatedAt: new Date("2026-09-14"),
        },
      ],
      "LINKEDIN",
    );
    expect(picked?.status).toBe("ACTIVE");
  });
});

describe("evaluateOrganisationConnectors honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integrationFindFirst.mockResolvedValue(null);
    capabilityUpsert.mockResolvedValue({});
    capabilityDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("marks Zernio LinkedIn PUBLISH connected without native OAuth scopes", async () => {
    socialFindMany.mockResolvedValue([
      {
        id: "sc_zernio_li",
        platform: "LINKEDIN",
        status: "ACTIVE",
        scopes: ["zernio:publish"],
        capabilities: { listen: true, publish: true, message: false },
        expiresAt: null,
        lastSyncedAt: new Date("2026-09-14"),
        updatedAt: new Date("2026-09-14"),
        externalAccountId: "zernio:li_prod",
        metadata: { provider: "ZERNIO", zernioNetwork: "linkedin", zernioAccountId: "li_prod" },
      },
      {
        id: "sc_old_error",
        platform: "LINKEDIN",
        status: "ERROR",
        scopes: [],
        capabilities: {},
        expiresAt: null,
        lastSyncedAt: new Date("2026-09-02"),
        updatedAt: new Date("2026-09-02"),
        externalAccountId: "stale-native",
        metadata: {},
      },
    ]);

    const rows = await evaluateOrganisationConnectors("org_honest");
    const linkedin = rows.find((r) => r.providerKey === "linkedin");
    expect(linkedin?.connectionStatus).toBe(ConnectorConnectionStatus.CONNECTED);
    expect(linkedin?.connectionRef).toBe("sc_zernio_li");
    const publish = linkedin?.capabilities.find((c) => c.capability === "PUBLISH");
    expect(publish?.status).toBe(ConnectorCapabilityStatus.CONNECTED);
    expect(publish?.provenance).toMatch(/ZERNIO/i);
    expect(publish?.missingScopes ?? []).toEqual([]);

    const ghostDeletes = capabilityDeleteMany.mock.calls.filter((call) => {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      return (
        where.organisationId === "org_honest" &&
        where.providerKey === "linkedin" &&
        where.connectionRef === "none" &&
        where.status === ConnectorCapabilityStatus.AUTH_REQUIRED
      );
    });
    expect(ghostDeletes.length).toBeGreaterThan(0);
    expect(capabilityDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_honest",
          providerKey: "linkedin",
          NOT: { connectionRef: "sc_zernio_li" },
        }),
      }),
    );
  });

  it("still requires native LinkedIn scopes when the connection is not Zernio/Ayrshare", async () => {
    socialFindMany.mockResolvedValue([
      {
        id: "sc_native_li",
        platform: "LINKEDIN",
        status: "ACTIVE",
        scopes: ["r_liteprofile"],
        capabilities: {},
        expiresAt: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
        externalAccountId: "native-li",
        metadata: {},
      },
    ]);

    const rows = await evaluateOrganisationConnectors("org_native");
    const publish = rows
      .find((r) => r.providerKey === "linkedin")
      ?.capabilities.find((c) => c.capability === "PUBLISH");
    expect(publish?.status).toBe(ConnectorCapabilityStatus.SCOPE_REQUIRED);
    expect(publish?.missingScopes).toContain("w_member_social");
  });

  it("marks Zernio Instagram PUBLISH connected and does not invent native SCOPE_REQUIRED", async () => {
    socialFindMany.mockResolvedValue([
      {
        id: "sc_zernio_ig",
        platform: "INSTAGRAM",
        status: "ACTIVE",
        scopes: ["zernio:publish"],
        capabilities: { listen: true, publish: true, message: true },
        expiresAt: null,
        lastSyncedAt: new Date("2026-09-14"),
        updatedAt: new Date("2026-09-14"),
        externalAccountId: "zernio:ig_prod",
        metadata: { provider: "ZERNIO", zernioNetwork: "instagram", zernioAccountId: "ig_prod" },
      },
    ]);

    const rows = await evaluateOrganisationConnectors("org_ig");
    expect(socialFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: "org_ig" } }),
    );
    const instagram = rows.find((r) => r.providerKey === "instagram");
    expect(instagram?.connectionStatus).toBe(ConnectorConnectionStatus.CONNECTED);
    expect(instagram?.connectionRef).toBe("sc_zernio_ig");
    const publish = instagram?.capabilities.find((c) => c.capability === "PUBLISH");
    expect(publish?.status).toBe(ConnectorCapabilityStatus.CONNECTED);
    expect(publish?.provenance).toMatch(/ZERNIO/i);
  });

  it("keeps org B AUTH_REQUIRED after org A Zernio sync", async () => {
    socialFindMany.mockImplementation(async (args: { where?: { organisationId?: string } }) => {
      if (args.where?.organisationId === "org_a") {
        return [
          {
            id: "sc_zernio_a",
            platform: "LINKEDIN",
            status: "ACTIVE",
            scopes: ["zernio:publish"],
            capabilities: { publish: true },
            expiresAt: null,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
            externalAccountId: "zernio:li_a",
            metadata: { provider: "ZERNIO" },
          },
        ];
      }
      return [];
    });

    const rowsA = await evaluateOrganisationConnectors("org_a");
    const rowsB = await evaluateOrganisationConnectors("org_b");
    const publishA = rowsA
      .find((r) => r.providerKey === "linkedin")
      ?.capabilities.find((c) => c.capability === "PUBLISH");
    const linkedinB = rowsB.find((r) => r.providerKey === "linkedin");
    const publishB = linkedinB?.capabilities.find((c) => c.capability === "PUBLISH");
    expect(publishA?.status).toBe(ConnectorCapabilityStatus.CONNECTED);
    expect(linkedinB?.connectionRef).toBe("none");
    expect(publishB?.status).toBe(ConnectorCapabilityStatus.AUTH_REQUIRED);
  });

  it("keeps ManyChat WEBHOOK_RECEIVE AUTH_REQUIRED until an org secret exists", async () => {
    const prevToken = process.env.MANYCHAT_API_TOKEN;
    const prevSecret = process.env.MANYCHAT_WEBHOOK_SECRET;
    process.env.MANYCHAT_API_TOKEN = "env-shared-token";
    process.env.MANYCHAT_WEBHOOK_SECRET = "env-shared-secret";
    socialFindMany.mockResolvedValue([]);
    integrationFindFirst.mockResolvedValue(null);

    try {
      const rows = await evaluateOrganisationConnectors("org_new");
      const manychat = rows.find((r) => r.providerKey === "manychat");
      const receive = manychat?.capabilities.find((c) => c.capability === "WEBHOOK_RECEIVE");
      expect(receive?.status).toBe(ConnectorCapabilityStatus.AUTH_REQUIRED);
      expect(receive?.provenance).toMatch(/AUTH_REQUIRED/i);
    } finally {
      if (prevToken === undefined) delete process.env.MANYCHAT_API_TOKEN;
      else process.env.MANYCHAT_API_TOKEN = prevToken;
      if (prevSecret === undefined) delete process.env.MANYCHAT_WEBHOOK_SECRET;
      else process.env.MANYCHAT_WEBHOOK_SECRET = prevSecret;
    }
  });
});
