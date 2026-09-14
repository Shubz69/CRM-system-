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
});
