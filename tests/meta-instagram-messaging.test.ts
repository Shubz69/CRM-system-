import { createHmac } from "crypto";
import { MemberRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { roleHasPermission } from "@/lib/permissions";
import { META_INSTAGRAM_MESSAGING_SCOPES } from "@/services/messaging/providers";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
  decryptSecret: vi.fn((v: string) => (String(v).startsWith("enc:") ? String(v).slice(4) : v)),
  oAuthStateCreate: vi.fn(),
  oAuthStateFindUnique: vi.fn(),
  oAuthStateUpdate: vi.fn(),
  integrationFindUnique: vi.fn(),
  integrationFindFirst: vi.fn(),
  integrationUpdate: vi.fn(),
  integrationUpdateMany: vi.fn(),
  integrationUpsert: vi.fn(),
  credentialFindUnique: vi.fn(),
  credentialUpsert: vi.fn(),
  credentialUpdateMany: vi.fn(),
  messagingChannelFindFirst: vi.fn(),
  messagingChannelUpsert: vi.fn(),
  messagingChannelUpdateMany: vi.fn(),
  messageFindFirst: vi.fn(),
  contactFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  isContactSuppressed: vi.fn(),
  writeAuditLog: vi.fn(),
  processInboundMessage: vi.fn(),
  requirePermission: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mocks.getEnv(),
  assertProductionSecretsConfigured: () => undefined,
}));

vi.mock("@/lib/crypto", () => ({
  encryptSecret: (...args: unknown[]) => mocks.encryptSecret(...(args as [string])),
  decryptSecret: (...args: unknown[]) => mocks.decryptSecret(...(args as [string])),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthStateConsumption: {
      create: mocks.oAuthStateCreate,
      findUnique: mocks.oAuthStateFindUnique,
      update: mocks.oAuthStateUpdate,
    },
    integration: {
      findUnique: mocks.integrationFindUnique,
      findFirst: mocks.integrationFindFirst,
      update: mocks.integrationUpdate,
      updateMany: mocks.integrationUpdateMany,
      upsert: mocks.integrationUpsert,
    },
    integrationCredential: {
      findUnique: mocks.credentialFindUnique,
      upsert: mocks.credentialUpsert,
      updateMany: mocks.credentialUpdateMany,
    },
    messagingChannel: {
      findFirst: mocks.messagingChannelFindFirst,
      upsert: mocks.messagingChannelUpsert,
      updateMany: mocks.messagingChannelUpdateMany,
    },
    message: { findFirst: mocks.messageFindFirst },
    contact: { findFirst: mocks.contactFindFirst },
    conversation: { findFirst: mocks.conversationFindFirst },
  },
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

vi.mock("@/services/messaging/suppression", () => ({
  isContactSuppressed: (...args: unknown[]) => mocks.isContactSuppressed(...args),
}));

vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => mocks.processInboundMessage(...args),
}));

vi.mock("@/services/usage", () => ({
  recordUsage: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
  jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => true,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  normalizeMetaInstagramWebhookMessage,
  normalizeAllMetaInstagramWebhookMessages,
} from "@/adapters/messaging/meta-instagram";
import {
  assertContactable,
  ContactabilityError,
} from "@/services/messaging/contactability";
import { resolveMessagingSendCredential } from "@/services/messaging/credentials";
import {
  consumeMetaInstagramOAuthState,
  createMetaInstagramOAuthState,
  disconnectMetaInstagram,
  getMetaInstagramConnectionView,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
} from "@/services/messaging/meta-instagram";
import { GET as webhookGet, POST as webhookPost } from "@/app/api/webhooks/meta/instagram/route";
import { GET as connectGet } from "@/app/api/integrations/meta-instagram/connect/route";

function metaEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    INSTAGRAM_APP_ID: "ig-app-id",
    INSTAGRAM_APP_SECRET: "ig-app-secret",
    META_APP_ID: undefined,
    META_APP_SECRET: undefined,
    INSTAGRAM_GRAPH_API_VERSION: "v26.0",
    META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "verify-token-test",
    META_INSTAGRAM_MESSAGING_REDIRECT_URI: "http://localhost:3000/api/integrations/meta-instagram/callback",
    APP_URL: "http://localhost:3000",
    NEXTAUTH_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("Meta Instagram messaging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mocks.fetch as unknown as typeof fetch;
    mocks.getEnv.mockReturnValue(metaEnv());
    mocks.encryptSecret.mockImplementation((v: string) => `enc:${v}`);
    mocks.decryptSecret.mockImplementation((v: string) =>
      String(v).startsWith("enc:") ? String(v).slice(4) : v,
    );
    mocks.isContactSuppressed.mockResolvedValue(false);
    mocks.requirePermission.mockResolvedValue({
      organisationId: "org-a",
      userId: "user-a",
    });
  });

  describe("OAuth state CSRF / expiry / replay / org binding", () => {
    it("creates consumable state bound to org and user", async () => {
      mocks.oAuthStateCreate.mockResolvedValue({});
      const state = await createMetaInstagramOAuthState({
        organisationId: "org-a",
        userId: "user-a",
      });
      expect(typeof state).toBe("string");
      expect(mocks.oAuthStateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organisationId: "org-a",
            userId: "user-a",
            purpose: "meta_instagram_messaging",
          }),
        }),
      );

      // decryptSecret returns the encrypted payload JSON from createOAuthState
      const payloadJson = mocks.encryptSecret.mock.calls[0]?.[0] as string;
      const payload = JSON.parse(payloadJson) as {
        organisationId: string;
        userId: string;
        platform: string;
      };
      const nonce = payload.platform.split(":")[1];
      mocks.decryptSecret.mockReturnValue(payloadJson);
      mocks.oAuthStateFindUnique.mockResolvedValue({
        nonce,
        organisationId: "org-a",
        userId: "user-a",
        purpose: "meta_instagram_messaging",
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      mocks.oAuthStateUpdate.mockResolvedValue({});

      const consumed = await consumeMetaInstagramOAuthState(state);
      expect(consumed).toEqual({
        organisationId: "org-a",
        userId: "user-a",
        nonce,
      });
    });

    it("rejects expired nonce row", async () => {
      const payload = {
        organisationId: "org-a",
        userId: "user-a",
        platform: "meta_instagram_messaging:nonce1",
        nonce: "outer",
        issuedAt: Date.now(),
      };
      mocks.decryptSecret.mockReturnValue(JSON.stringify(payload));
      mocks.oAuthStateFindUnique.mockResolvedValue({
        nonce: "nonce1",
        organisationId: "org-a",
        purpose: "meta_instagram_messaging",
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await consumeMetaInstagramOAuthState("state")).toBeNull();
    });

    it("rejects replayed (already consumed) state", async () => {
      const payload = {
        organisationId: "org-a",
        userId: "user-a",
        platform: "meta_instagram_messaging:nonce1",
        nonce: "outer",
        issuedAt: Date.now(),
      };
      mocks.decryptSecret.mockReturnValue(JSON.stringify(payload));
      mocks.oAuthStateFindUnique.mockResolvedValue({
        nonce: "nonce1",
        organisationId: "org-a",
        purpose: "meta_instagram_messaging",
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await consumeMetaInstagramOAuthState("state")).toBeNull();
    });

    it("rejects org binding mismatch", async () => {
      const payload = {
        organisationId: "org-a",
        userId: "user-a",
        platform: "meta_instagram_messaging:nonce1",
        nonce: "outer",
        issuedAt: Date.now(),
      };
      mocks.decryptSecret.mockReturnValue(JSON.stringify(payload));
      mocks.oAuthStateFindUnique.mockResolvedValue({
        nonce: "nonce1",
        organisationId: "org-other",
        purpose: "meta_instagram_messaging",
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await consumeMetaInstagramOAuthState("state")).toBeNull();
    });
  });

  describe("token encryption never returned", () => {
    it("connection view excludes tokens", async () => {
      mocks.integrationFindUnique.mockResolvedValue({
        id: "int-1",
        isActive: true,
        config: {
          igUserId: "1784",
          username: "brand",
          scopes: [...META_INSTAGRAM_MESSAGING_SCOPES],
          webhookSubscribed: true,
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      mocks.credentialFindUnique.mockResolvedValue({
        id: "cred-1",
        encryptedValue: "enc:super-secret-token",
        healthStatus: "HEALTHY",
      });
      mocks.decryptSecret.mockReturnValue("super-secret-token");

      const view = await getMetaInstagramConnectionView("org-a");
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain("enc:");
      expect(view.username).toBe("brand");
      expect(view.health).toBe("CONNECTED");
    });
  });

  describe("webhook GET verify", () => {
    it("returns challenge for good token", async () => {
      const req = new Request(
        "http://localhost/api/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=verify-token-test&hub.challenge=12345",
      );
      const res = await webhookGet(req as never);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("12345");
    });

    it("rejects bad token", async () => {
      const req = new Request(
        "http://localhost/api/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
      );
      const res = await webhookGet(req as never);
      expect(res.status).toBe(403);
    });

    it("verifyMetaWebhookChallenge unit helpers", () => {
      expect(
        verifyMetaWebhookChallenge({
          mode: "subscribe",
          token: "verify-token-test",
          challenge: "abc",
        }),
      ).toBe("abc");
      expect(
        verifyMetaWebhookChallenge({
          mode: "subscribe",
          token: "nope",
          challenge: "abc",
        }),
      ).toBeNull();
    });
  });

  describe("webhook signature", () => {
    it("accepts valid signature and rejects invalid/missing", () => {
      const raw = '{"object":"instagram"}';
      const good = createHmac("sha256", "ig-app-secret").update(raw, "utf8").digest("hex");
      expect(
        verifyMetaWebhookSignature({ rawBody: raw, signatureHeader: `sha256=${good}` }),
      ).toBe(true);
      expect(
        verifyMetaWebhookSignature({ rawBody: raw, signatureHeader: "sha256=deadbeef" }),
      ).toBe(false);
      expect(verifyMetaWebhookSignature({ rawBody: raw, signatureHeader: null })).toBe(false);
    });

    it("POST rejects missing signature", async () => {
      const req = new Request("http://localhost/api/webhooks/meta/instagram", {
        method: "POST",
        body: '{"entry":[]}',
        headers: { "Content-Type": "application/json" },
      });
      const res = await webhookPost(req as never);
      expect(res.status).toBe(401);
    });

    it("POST rejects invalid signature", async () => {
      const req = new Request("http://localhost/api/webhooks/meta/instagram", {
        method: "POST",
        body: '{"entry":[]}',
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=00",
        },
      });
      const res = await webhookPost(req as never);
      expect(res.status).toBe(401);
    });
  });

  describe("unknown IG fail closed", () => {
    it("acks 200 with ignored diagnostic for unknown recipient", async () => {
      const payload = {
        object: "instagram",
        entry: [
          {
            id: "ig-business-unknown",
            messaging: [
              {
                sender: { id: "user-1" },
                recipient: { id: "ig-business-unknown" },
                timestamp: Date.now(),
                message: { mid: "m1", text: "hi" },
              },
            ],
          },
        ],
      };
      const raw = JSON.stringify(payload);
      const sig = createHmac("sha256", "ig-app-secret").update(raw, "utf8").digest("hex");
      mocks.messagingChannelFindFirst.mockResolvedValue(null);

      const req = new Request("http://localhost/api/webhooks/meta/instagram", {
        method: "POST",
        body: raw,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": `sha256=${sig}`,
        },
      });
      const res = await webhookPost(req as never);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.results[0].ignored).toBe(true);
      expect(json.results[0].reason).toBe("unknown_instagram_account");
      expect(mocks.processInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe("inbound normalize + mid dedupe key", () => {
    it("normalizes inbound text and exposes mid as externalMessageId", () => {
      const normalized = normalizeMetaInstagramWebhookMessage({
        entry: [
          {
            id: "biz",
            messaging: [
              {
                sender: { id: "igsid" },
                recipient: { id: "biz" },
                timestamp: 1_700_000_000_000,
                message: { mid: "mid_abc", text: "Hello" },
              },
            ],
          },
        ],
      });
      expect(normalized).toMatchObject({
        provider: "meta_instagram",
        contactExternalId: "igsid",
        text: "Hello",
        externalMessageId: "mid_abc",
        threadId: "biz:igsid",
      });
    });

    it("skips echoes and batches multiple messages", () => {
      const all = normalizeAllMetaInstagramWebhookMessages({
        entry: [
          {
            id: "biz",
            messaging: [
              {
                sender: { id: "biz" },
                recipient: { id: "user" },
                message: { mid: "echo", text: "out", is_echo: true },
              },
              {
                sender: { id: "user" },
                recipient: { id: "biz" },
                message: { mid: "in1", text: "one" },
              },
            ],
          },
        ],
      });
      expect(all).toHaveLength(1);
      expect(all[0]?.externalMessageId).toBe("in1");
    });
  });

  describe("required scopes", () => {
    it("marks DEGRADED when messaging scopes missing", async () => {
      mocks.integrationFindUnique.mockResolvedValue({
        id: "int-1",
        isActive: true,
        config: {
          igUserId: "1784",
          username: "brand",
          scopes: ["instagram_business_basic"],
          webhookSubscribed: true,
        },
      });
      mocks.credentialFindUnique.mockResolvedValue({
        id: "cred-1",
        encryptedValue: "enc:tok",
        healthStatus: "HEALTHY",
      });
      const view = await getMetaInstagramConnectionView("org-a");
      expect(view.health).toBe("DEGRADED");
      expect(META_INSTAGRAM_MESSAGING_SCOPES).toContain("instagram_business_manage_messages");
    });
  });

  describe("contactability no prior inbound", () => {
    it("blocks all outbound without prior inbound on meta_instagram", async () => {
      mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
      mocks.conversationFindFirst.mockResolvedValue({
        closedAt: null,
        aiPaused: false,
        handlingMode: "AI",
        lastInboundAt: null,
        messagingWindowExpiresAt: null,
        humanMessagingWindowExpiresAt: null,
        metadata: {},
      });
      mocks.messageFindFirst.mockResolvedValue(null);

      await expect(
        assertContactable({
          organisationId: "org-a",
          contactId: "c1",
          conversationId: "conv1",
          channel: "meta_instagram",
          actionType: "HUMAN_REPLY",
        }),
      ).rejects.toBeInstanceOf(ContactabilityError);

      await expect(
        assertContactable({
          organisationId: "org-a",
          contactId: "c1",
          conversationId: "conv1",
          channel: "meta_instagram",
          actionType: "AI_REPLY",
        }),
      ).rejects.toMatchObject({ code: "META_INSTAGRAM_NO_PRIOR_INBOUND" });
    });

    it("allows when prior inbound exists", async () => {
      mocks.contactFindFirst.mockResolvedValue({ optedOut: false, metadata: {} });
      mocks.conversationFindFirst.mockResolvedValue({
        closedAt: null,
        aiPaused: false,
        handlingMode: "AI",
        lastInboundAt: new Date(),
        messagingWindowExpiresAt: new Date(Date.now() + 86_400_000),
        humanMessagingWindowExpiresAt: new Date(Date.now() + 86_400_000),
        metadata: {},
      });
      mocks.messageFindFirst.mockResolvedValue({ id: "m-in" });

      await expect(
        assertContactable({
          organisationId: "org-a",
          contactId: "c1",
          conversationId: "conv1",
          channel: "meta_instagram",
          actionType: "HUMAN_REPLY",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("credentials + disconnect", () => {
    it("resolves meta credential without ManyChat env fallback", async () => {
      mocks.getEnv.mockReturnValue({
        ...metaEnv(),
        MANYCHAT_API_TOKEN: "env-manychat-should-not-use",
      });
      mocks.integrationFindUnique.mockResolvedValue({
        id: "meta-int",
        isActive: true,
        config: { igUserId: "1784" },
      });
      mocks.credentialFindUnique.mockResolvedValue({
        id: "cred",
        encryptedValue: "enc:meta-tok",
        healthStatus: "HEALTHY",
      });
      mocks.decryptSecret.mockReturnValue("meta-tok");

      const result = await resolveMessagingSendCredential("org-a", {
        provider: "meta_instagram",
      });
      expect(result).toEqual({
        token: "meta-tok",
        source: "organisation",
        connectionRef: "meta_instagram:meta-int",
        igUserId: "1784",
      });
      expect(result.token).not.toBe("env-manychat-should-not-use");
    });

    it("disconnect revokes credential and deactivates channel", async () => {
      mocks.integrationFindUnique.mockResolvedValue({ id: "meta-int", isActive: true });
      mocks.integrationUpdate.mockResolvedValue({});
      mocks.credentialUpdateMany.mockResolvedValue({ count: 1 });
      mocks.messagingChannelUpdateMany.mockResolvedValue({ count: 1 });

      await disconnectMetaInstagram({ organisationId: "org-a", userId: "user-a" });

      expect(mocks.integrationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "meta-int" },
          data: { isActive: false },
        }),
      );
      expect(mocks.credentialUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ healthStatus: "REVOKED" }),
        }),
      );
      expect(mocks.writeAuditLog).toHaveBeenCalled();
    });
  });

  describe("readonly cannot connect", () => {
    it("READ_ONLY lacks integrations:manage", () => {
      expect(roleHasPermission(MemberRole.READ_ONLY, "integrations:manage")).toBe(false);
      expect(roleHasPermission(MemberRole.OWNER, "integrations:manage")).toBe(true);
    });

    it("connect route returns 403 when permission denied", async () => {
      mocks.requirePermission.mockRejectedValue(new Error("Forbidden: missing permission"));
      const res = await connectGet();
      expect(res.status).toBe(403);
    });
  });

  describe("API version + env precedence + send endpoint + refresh", () => {
    it("defaults Graph API version to v26.0 and never v21.0", async () => {
      const {
        resolveMetaGraphApiVersion,
        DEFAULT_META_GRAPH_API_VERSION,
        getMetaGraphVersion,
      } = await import("@/services/messaging/meta-instagram");
      expect(DEFAULT_META_GRAPH_API_VERSION).toBe("v26.0");
      expect(resolveMetaGraphApiVersion("")).toBe("v26.0");
      expect(resolveMetaGraphApiVersion(undefined)).toBe("v26.0");
      expect(resolveMetaGraphApiVersion("26.0")).toBe("v26.0");
      expect(resolveMetaGraphApiVersion("v26.0")).toBe("v26.0");
      expect(resolveMetaGraphApiVersion("not-a-version")).toBe("v26.0");
      mocks.getEnv.mockReturnValue(metaEnv({ INSTAGRAM_GRAPH_API_VERSION: "" }));
      expect(getMetaGraphVersion()).toBe("v26.0");
      mocks.getEnv.mockReturnValue(metaEnv({ INSTAGRAM_GRAPH_API_VERSION: "v26.0" }));
      expect(getMetaGraphVersion()).toBe("v26.0");
    });

    it("prefers INSTAGRAM_* over META_* when both set", async () => {
      const { resolveMetaAppCredentials } = await import("@/services/messaging/meta-instagram");
      mocks.getEnv.mockReturnValue(
        metaEnv({
          INSTAGRAM_APP_ID: "canonical-id",
          INSTAGRAM_APP_SECRET: "canonical-secret",
          META_APP_ID: "alias-id",
          META_APP_SECRET: "alias-secret",
        }),
      );
      const creds = resolveMetaAppCredentials();
      expect(creds).toEqual({
        appId: "canonical-id",
        appSecret: "canonical-secret",
        source: "INSTAGRAM_*",
      });
    });

    it("falls back to META_* aliases only when INSTAGRAM_* unset", async () => {
      const { resolveMetaAppCredentials } = await import("@/services/messaging/meta-instagram");
      mocks.getEnv.mockReturnValue(
        metaEnv({
          INSTAGRAM_APP_ID: undefined,
          INSTAGRAM_APP_SECRET: undefined,
          META_APP_ID: "alias-id",
          META_APP_SECRET: "alias-secret",
        }),
      );
      expect(resolveMetaAppCredentials()).toEqual({
        appId: "alias-id",
        appSecret: "alias-secret",
        source: "META_*",
      });
    });

    it("messaging scopes are Instagram Login prefixed and exclude publish/comments", () => {
      expect([...META_INSTAGRAM_MESSAGING_SCOPES]).toEqual([
        "instagram_business_basic",
        "instagram_business_manage_messages",
      ]);
      expect(META_INSTAGRAM_MESSAGING_SCOPES).not.toContain("business_basic");
      expect(META_INSTAGRAM_MESSAGING_SCOPES).not.toContain("instagram_business_content_publish");
      expect(META_INSTAGRAM_MESSAGING_SCOPES).not.toContain("instagram_business_manage_comments");
    });

    it("send uses explicit ig-user-id messages endpoint with IGSID recipient", async () => {
      mocks.getEnv.mockReturnValue(metaEnv());
      mocks.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ message_id: "mid.123" }),
      });
      const { MetaInstagramMessagingAdapter } = await import("@/adapters/messaging/meta-instagram");
      const adapter = new MetaInstagramMessagingAdapter();
      const result = await adapter.sendMessage({
        organisationId: "org-a",
        contactExternalId: "igsid-recipient",
        text: "hello",
        apiToken: "tok",
        metadata: { igUserId: "17841400000000000" },
      });
      expect(result.ok).toBe(true);
      expect(mocks.fetch).toHaveBeenCalledWith(
        "https://graph.instagram.com/v26.0/17841400000000000/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            recipient: { id: "igsid-recipient" },
            message: { text: "hello" },
          }),
        }),
      );
    });

    it("send rejects username recipients and missing igUserId", async () => {
      const { MetaInstagramMessagingAdapter } = await import("@/adapters/messaging/meta-instagram");
      const adapter = new MetaInstagramMessagingAdapter();
      await expect(
        adapter.sendMessage({
          organisationId: "org-a",
          contactExternalId: "@someone",
          text: "x",
          apiToken: "tok",
          metadata: { igUserId: "1784" },
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/scoped user id/i) });
      await expect(
        adapter.sendMessage({
          organisationId: "org-a",
          contactExternalId: "igsid",
          text: "x",
          apiToken: "tok",
          metadata: {},
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/account id missing/i) });
    });

    it("refresh failure marks REAUTH_REQUIRED", async () => {
      mocks.getEnv.mockReturnValue(metaEnv());
      mocks.integrationFindUnique.mockResolvedValue({
        id: "meta-int",
        isActive: true,
        config: {
          igUserId: "1784",
          username: "brand",
          scopes: [...META_INSTAGRAM_MESSAGING_SCOPES],
          webhookSubscribed: true,
        },
      });
      mocks.credentialFindUnique.mockResolvedValue({
        id: "cred",
        encryptedValue: "enc:old-tok",
        healthStatus: "HEALTHY",
      });
      mocks.decryptSecret.mockReturnValue("old-tok");
      mocks.credentialUpdateMany.mockResolvedValue({ count: 1 });
      mocks.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "1784", username: "brand" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "Cannot refresh" } }),
        });

      const { validateMetaInstagramConnection } = await import(
        "@/services/messaging/meta-instagram"
      );
      const result = await validateMetaInstagramConnection("org-a");
      expect(result.health).toBe("REAUTH_REQUIRED");
      expect(result.ok).toBe(false);
      expect(mocks.credentialUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ healthStatus: "EXPIRED" }),
        }),
      );
    });
  });
});
