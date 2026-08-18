/**
 * DB integration — encrypted token round-trip + org isolation for Social Connections.
 * Skipped only when DATABASE_URL is unset; if set but unreachable, fails loudly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SocialConnectionStatus, SocialPlatform } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  disconnectSocialConnection,
  getConnectionAccessToken,
  listSocialConnections,
  upsertSocialConnection,
} from "@/services/social-connections";
import { createTestOrganisation, destroyTestOrganisation, type TestOrganisationFixture } from "./helpers/org-fixtures";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)("social connections — DB integration", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DATABASE_URL is set but Postgres is unreachable — refusing to skip. ${message}`);
    }
    orgA = await createTestOrganisation("social-a");
    orgB = await createTestOrganisation("social-b");
  });

  afterAll(async () => {
    await destroyTestOrganisation(orgA);
    await destroyTestOrganisation(orgB);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.socialConnection.deleteMany({
      where: { organisationId: { in: [orgA.organisationId, orgB.organisationId] } },
    });
  });

  it("stores the access token encrypted and decrypts it back exactly", async () => {
    const connection = await upsertSocialConnection({
      organisationId: orgA.organisationId,
      platform: SocialPlatform.INSTAGRAM,
      externalAccountId: "ig_12345",
      displayName: "@test_account",
      accessToken: "super-secret-access-token",
      refreshToken: "super-secret-refresh-token",
      expiresInSeconds: 3600,
      scopes: ["instagram_business_basic"],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_1",
    });

    const raw = await prisma.socialConnectionCredential.findUniqueOrThrow({
      where: { socialConnectionId_keyName: { socialConnectionId: connection.id, keyName: "access_token" } },
    });
    expect(raw.encryptedValue).not.toContain("super-secret-access-token");

    const decrypted = await getConnectionAccessToken(connection.id);
    expect(decrypted).toBe("super-secret-access-token");
    expect(connection.status).toBe(SocialConnectionStatus.ACTIVE);
  });

  it("upserts idempotently on (organisationId, platform, externalAccountId)", async () => {
    await upsertSocialConnection({
      organisationId: orgA.organisationId,
      platform: SocialPlatform.LINKEDIN,
      externalAccountId: "li_999",
      accessToken: "token-v1",
      scopes: ["w_member_social"],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_1",
    });
    const second = await upsertSocialConnection({
      organisationId: orgA.organisationId,
      platform: SocialPlatform.LINKEDIN,
      externalAccountId: "li_999",
      accessToken: "token-v2",
      scopes: ["w_member_social"],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_1",
    });

    const rows = await prisma.socialConnection.findMany({
      where: { organisationId: orgA.organisationId, platform: SocialPlatform.LINKEDIN },
    });
    expect(rows).toHaveLength(1);
    expect(await getConnectionAccessToken(second.id)).toBe("token-v2");
  });

  it("cannot disconnect another organisation's connection", async () => {
    const connection = await upsertSocialConnection({
      organisationId: orgB.organisationId,
      platform: SocialPlatform.TIKTOK,
      externalAccountId: "tt_1",
      accessToken: "token",
      scopes: ["user.info.basic"],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_2",
    });

    const result = await disconnectSocialConnection(orgA.organisationId, connection.id);
    expect(result).toBeNull();

    const stillActive = await prisma.socialConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(stillActive.status).toBe(SocialConnectionStatus.ACTIVE);
  });

  it("disconnect deletes the stored tokens and marks the connection REVOKED", async () => {
    const connection = await upsertSocialConnection({
      organisationId: orgA.organisationId,
      platform: SocialPlatform.TIKTOK,
      externalAccountId: "tt_2",
      accessToken: "token",
      refreshToken: "refresh",
      scopes: ["user.info.basic"],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_1",
    });

    const disconnected = await disconnectSocialConnection(orgA.organisationId, connection.id);
    expect(disconnected?.status).toBe(SocialConnectionStatus.REVOKED);

    const credentials = await prisma.socialConnectionCredential.findMany({
      where: { socialConnectionId: connection.id },
    });
    expect(credentials).toHaveLength(0);
  });

  it("lists only the requesting organisation's connections", async () => {
    await upsertSocialConnection({
      organisationId: orgA.organisationId,
      platform: SocialPlatform.INSTAGRAM,
      externalAccountId: "ig_a",
      accessToken: "token",
      scopes: [],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_1",
    });
    await upsertSocialConnection({
      organisationId: orgB.organisationId,
      platform: SocialPlatform.INSTAGRAM,
      externalAccountId: "ig_b",
      accessToken: "token",
      scopes: [],
      capabilities: { listen: true, publish: true, message: false },
      connectedByUserId: "user_2",
    });

    const orgAConnections = await listSocialConnections(orgA.organisationId);
    expect(orgAConnections).toHaveLength(1);
    expect(orgAConnections[0]?.externalAccountId).toBe("ig_a");
  });
});
