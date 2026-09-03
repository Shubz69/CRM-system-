/**
 * Content OS publish-target resolution — Zernio connectedAccounts → SocialConnection.
 * NOT LIVE_E2E.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialConnectionStatus, SocialPlatform } from "@prisma/client";

const profileFind = vi.fn();
const connectionUpsert = vi.fn();
const connectionFindMany = vi.fn();
const connectionFindFirst = vi.fn();
const connectionUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      upsert: (...a: unknown[]) => connectionUpsert(...a),
      findMany: (...a: unknown[]) => connectionFindMany(...a),
      findFirst: (...a: unknown[]) => connectionFindFirst(...a),
      update: (...a: unknown[]) => connectionUpdate(...a),
    },
  },
}));

vi.mock("@/adapters/zernio", () => ({
  getOrCreateZernioProfile: (...a: unknown[]) => profileFind(...a),
}));

import {
  isZernioBackedConnection,
  listPublishTargets,
  resolvePublishTargetConnection,
  syncPublishTargetsFromConnectedAccounts,
  zernioAccountIdFromConnection,
} from "@/services/publishing/publish-targets";

describe("publish-targets resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileFind.mockResolvedValue({
      organisationId: "org_a",
      connectedAccounts: [
        {
          accountId: "ig_1",
          platform: "instagram",
          username: "acme",
          status: "connected",
        },
        {
          accountId: "li_1",
          platform: "linkedin",
          displayName: "Acme Ltd",
          status: "connected",
        },
        {
          accountId: "yt_1",
          platform: "youtube",
          username: "acmechannel",
          status: "connected",
        },
        {
          accountId: "dead_1",
          platform: "instagram",
          username: "gone",
          status: "disconnected",
        },
      ],
    });
    connectionUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
      id: `sc_${(args.create.externalAccountId as string).replace(":", "_")}`,
      organisationId: "org_a",
      ...args.create,
      metadata: args.create.metadata,
    }));
    connectionFindMany.mockResolvedValue([]);
    connectionUpdate.mockResolvedValue({});
  });

  it("syncs only active IG/LI/YT accounts into SocialConnection rows", async () => {
    connectionFindMany
      .mockResolvedValueOnce([]) // existingZernio scan
      .mockResolvedValueOnce([
        {
          id: "sc_1",
          organisationId: "org_a",
          platform: SocialPlatform.INSTAGRAM,
          externalAccountId: "zernio:ig_1",
          displayName: "@acme",
          status: SocialConnectionStatus.ACTIVE,
          metadata: { provider: "ZERNIO", zernioNetwork: "instagram", zernioAccountId: "ig_1" },
        },
      ]);

    await syncPublishTargetsFromConnectedAccounts("org_a");
    expect(connectionUpsert).toHaveBeenCalledTimes(3);
    const platforms = connectionUpsert.mock.calls.map(
      (c) => (c[0] as { create: { platform: string } }).create.platform,
    );
    expect(platforms).toContain(SocialPlatform.INSTAGRAM);
    expect(platforms).toContain(SocialPlatform.LINKEDIN);
  });

  it("listPublishTargets returns customer labels and marks eligible", async () => {
    connectionFindMany.mockResolvedValue([
      {
        id: "sc_ig",
        organisationId: "org_a",
        platform: SocialPlatform.INSTAGRAM,
        externalAccountId: "zernio:ig_1",
        displayName: "@acme",
        status: SocialConnectionStatus.ACTIVE,
        metadata: {
          provider: "ZERNIO",
          zernioNetwork: "instagram",
          zernioAccountId: "ig_1",
          username: "acme",
        },
      },
      {
        id: "sc_yt",
        organisationId: "org_a",
        platform: SocialPlatform.TIKTOK,
        externalAccountId: "zernio:yt_1",
        displayName: "@acmechannel",
        status: SocialConnectionStatus.ACTIVE,
        metadata: {
          provider: "ZERNIO",
          zernioNetwork: "youtube",
          zernioAccountId: "yt_1",
        },
      },
    ]);

    const targets = await listPublishTargets("org_a");
    expect(targets.every((t) => t.eligible)).toBe(true);
    expect(targets.find((t) => t.platform === "INSTAGRAM")?.label).toBe("Instagram · @acme");
    expect(targets.find((t) => t.platform === "YOUTUBE")?.platform).toBe("YOUTUBE");
    expect(targets.find((t) => t.platform === "YOUTUBE")?.label).toMatch(/^YouTube ·/);
    expect(targets.every((t) => t.provider === "ZERNIO")).toBe(true);
  });

  it("resolvePublishTargetConnection denies cross-org ids", async () => {
    connectionFindFirst.mockResolvedValue(null);
    const hit = await resolvePublishTargetConnection({
      organisationId: "org_b",
      socialConnectionId: "sc_ig",
    });
    expect(hit).toBeNull();
    expect(connectionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org_b",
          id: "sc_ig",
        }),
      }),
    );
  });

  it("detects Zernio-backed connections and extracts account id", () => {
    expect(
      isZernioBackedConnection({
        externalAccountId: "zernio:ig_1",
        metadata: { provider: "ZERNIO", zernioAccountId: "ig_1" },
      }),
    ).toBe(true);
    expect(
      zernioAccountIdFromConnection({
        externalAccountId: "zernio:ig_1",
        metadata: { zernioAccountId: "ig_1" },
      }),
    ).toBe("ig_1");
    expect(
      isZernioBackedConnection({
        externalAccountId: "native_ig",
        metadata: {},
      }),
    ).toBe(false);
  });
});
