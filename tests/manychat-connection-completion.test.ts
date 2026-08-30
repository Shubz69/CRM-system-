import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueIntegration: vi.fn(),
  upsertIntegration: vi.fn(),
  findUniqueCredential: vi.fn(),
  upsertCredential: vi.fn(),
  updateIntegration: vi.fn(),
  updateCredential: vi.fn(),
  getEnv: vi.fn(),
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
  writeAuditLog: vi.fn(),
  requirePermission: vi.fn(),
  getOrganisationManyChatSecret: vi.fn(),
  maskSecret: vi.fn((v: string | null | undefined) => (v ? "••••" : "not set")),
  regenerateOrganisationManyChatSecret: vi.fn(),
  processInboundMessage: vi.fn(),
  dispatchOutboundMessage: vi.fn(),
  messagingChannelFindMany: vi.fn(),
  webhookEventFindMany: vi.fn(),
  contactIdentifierFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    integration: {
      findUnique: mocks.findUniqueIntegration,
      upsert: mocks.upsertIntegration,
      update: mocks.updateIntegration,
    },
    integrationCredential: {
      findUnique: mocks.findUniqueCredential,
      upsert: mocks.upsertCredential,
      update: mocks.updateCredential,
    },
    messagingChannel: {
      findMany: mocks.messagingChannelFindMany,
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    webhookEvent: { findMany: mocks.webhookEventFindMany },
    contactIdentifier: { findFirst: mocks.contactIdentifierFindFirst },
    conversation: { findFirst: mocks.conversationFindFirst },
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mocks.getEnv(),
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret: (...args: unknown[]) => mocks.decryptSecret(...args),
  encryptSecret: (...args: unknown[]) => mocks.encryptSecret(...(args as [string])),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
  jsonError: (message: string, status: number) =>
    Response.json({ error: message }, { status }),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

vi.mock("@/services/manychat-secrets", () => ({
  getOrganisationManyChatSecret: (...args: unknown[]) =>
    mocks.getOrganisationManyChatSecret(...args),
  maskSecret: (...args: unknown[]) => mocks.maskSecret(...(args as [string])),
  regenerateOrganisationManyChatSecret: (...args: unknown[]) =>
    mocks.regenerateOrganisationManyChatSecret(...args),
}));

vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => mocks.processInboundMessage(...args),
}));

vi.mock("@/services/messaging/outbound", () => ({
  dispatchOutboundMessage: (...args: unknown[]) => mocks.dispatchOutboundMessage(...args),
}));

import {
  disconnectOrganisationManyChat,
  getOrganisationManyChatApiToken,
  getOrganisationManyChatConnectionState,
  reconnectOrganisationManyChat,
  resolveMessagingSendCredential,
  setOrganisationManyChatApiToken,
} from "@/services/messaging/credentials";
import { POST as manychatPost, GET as manychatGet } from "@/app/api/integrations/manychat/route";
import { POST as channelsPost } from "@/app/api/messaging-channels/route";

describe("ManyChat connection completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mocks.fetch as unknown as typeof fetch;
    mocks.getEnv.mockReturnValue({
      MANYCHAT_API_TOKEN: "",
      MANYCHAT_WEBHOOK_SECRET: "env-secret",
      MANYCHAT_API_BASE_URL: "https://api.manychat.com",
      APP_URL: "http://localhost:3000",
      NEXTAUTH_URL: "http://localhost:3000",
    });
    mocks.decryptSecret.mockImplementation((v: string) =>
      String(v).startsWith("enc:") ? String(v).slice(4) : v,
    );
    mocks.requirePermission.mockResolvedValue({
      organisationId: "org-a",
      userId: "user-a",
    });
    mocks.getOrganisationManyChatSecret.mockResolvedValue("org-secret");
    mocks.messagingChannelFindMany.mockResolvedValue([
      { id: "ch-1", provider: "manychat", isActive: true, externalId: "page-1", displayName: "IG" },
    ]);
    mocks.webhookEventFindMany.mockResolvedValue([]);
    mocks.writeAuditLog.mockResolvedValue(undefined);
  });

  describe("token save — encrypted, never returned plaintext", () => {
    it("stores encrypted token and returns Configured status only", async () => {
      mocks.upsertIntegration.mockResolvedValue({ id: "int-a", isActive: true });
      mocks.findUniqueCredential.mockResolvedValue(null);
      mocks.upsertCredential.mockResolvedValue({ id: "cred-1" });

      const result = await setOrganisationManyChatApiToken("org-a", "plain-token-secret");

      expect(mocks.encryptSecret).toHaveBeenCalledWith("plain-token-secret");
      expect(mocks.upsertCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ encryptedValue: "enc:plain-token-secret" }),
        }),
      );
      expect(result.apiTokenStatus).toBe("Configured");
      expect(result.rotated).toBe(false);
      expect(JSON.stringify(result)).not.toContain("plain-token-secret");
    });

    it("save_api_token action never echoes plaintext in the response", async () => {
      mocks.upsertIntegration.mockResolvedValue({ id: "int-a", isActive: true });
      mocks.findUniqueCredential.mockResolvedValue(null);
      mocks.upsertCredential.mockResolvedValue({ id: "cred-1" });

      const res = await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save_api_token", apiToken: "super-secret-token" }),
        }) as never,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.apiTokenStatus).toBe("Configured");
      expect(json.apiTokenConfigured).toBe(true);
      expect(JSON.stringify(json)).not.toContain("super-secret-token");
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integration.api_token_saved" }),
      );
    });
  });

  describe("token rotation supersedes prior credential", () => {
    it("marks rotation when replacing existing ciphertext", async () => {
      mocks.upsertIntegration.mockResolvedValue({ id: "int-a", isActive: true });
      mocks.findUniqueCredential.mockResolvedValue({
        id: "cred-1",
        encryptedValue: "enc:old-token",
      });
      mocks.upsertCredential.mockResolvedValue({ id: "cred-1" });

      const result = await setOrganisationManyChatApiToken("org-a", "new-token");

      expect(result.rotated).toBe(true);
      expect(mocks.upsertCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            encryptedValue: "enc:new-token",
            healthNote: "Superseded by operator token rotation",
            lastRotatedAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe("disconnect / reconnect", () => {
    it("disconnect sets isActive=false, revokes credential, blocks outbound", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ id: "cred-1", keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.updateIntegration.mockResolvedValue({});
      mocks.updateCredential.mockResolvedValue({});

      await disconnectOrganisationManyChat("org-a");

      expect(mocks.updateIntegration).toHaveBeenCalledWith({
        where: { id: "int-a" },
        data: { isActive: false },
      });
      expect(mocks.updateCredential).toHaveBeenCalledWith({
        where: { id: "cred-1" },
        data: expect.objectContaining({ healthStatus: "REVOKED" }),
      });

      // After disconnect, resolver treats as revoked (no env fallback).
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: false,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.getEnv.mockReturnValue({ MANYCHAT_API_TOKEN: "env-token" });

      const resolved = await resolveMessagingSendCredential("org-a");
      expect(resolved.source).toBe("revoked");
      expect(resolved.token).toBeNull();
    });

    it("reconnect requires valid stored credential", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: false,
        credentials: [{ id: "cred-1", keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.updateIntegration.mockResolvedValue({});
      mocks.updateCredential.mockResolvedValue({});

      const result = await reconnectOrganisationManyChat("org-a");
      expect(result.connectionRef).toBe("manychat:int-a");
      expect(mocks.updateIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { isActive: true },
        }),
      );
    });

    it("reconnect fails without decryptable token", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: false,
        credentials: [],
      });
      await expect(reconnectOrganisationManyChat("org-a")).rejects.toThrow(/valid API token/i);
    });

    it("disconnect and reconnect actions are audited", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ id: "cred-1", keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.updateIntegration.mockResolvedValue({});
      mocks.updateCredential.mockResolvedValue({});

      await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          body: JSON.stringify({ action: "disconnect" }),
        }) as never,
      );
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integration.disconnected" }),
      );

      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: false,
        credentials: [{ id: "cred-1", keyName: "api_token", encryptedValue: "enc:tok" }],
      });

      await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          body: JSON.stringify({ action: "reconnect" }),
        }) as never,
      );
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integration.reconnected" }),
      );
    });
  });

  describe("validate vs send test", () => {
    it("validate_configuration does NOT call dispatchOutboundMessage", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.fetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const res = await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          body: JSON.stringify({ action: "validate_configuration" }),
        }) as never,
      );
      const json = await res.json();

      expect(json.ok).toBe(true);
      expect(json.sent).toBe(false);
      expect(json.message).toMatch(/no message was sent/i);
      expect(mocks.dispatchOutboundMessage).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledWith(
        "https://api.manychat.com/fb/page/getInfo",
        expect.anything(),
      );
    });

    it("send_test_message uses canonical dispatchOutboundMessage", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.contactIdentifierFindFirst.mockResolvedValue({
        contactId: "contact-1",
        contact: {
          conversations: [{ id: "conv-1" }],
        },
      });
      mocks.dispatchOutboundMessage.mockResolvedValue({
        ok: true,
        code: "CONFIRMED",
        dispatch: { id: "d1", externalOutcome: "CONFIRMED" },
      });

      const res = await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          body: JSON.stringify({
            action: "send_test_message",
            contactExternalId: "sub-99",
            text: "Hello test",
          }),
        }) as never,
      );
      const json = await res.json();

      expect(json.ok).toBe(true);
      expect(json.sent).toBe(true);
      expect(mocks.dispatchOutboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          organisationId: "org-a",
          conversationId: "conv-1",
          contactId: "contact-1",
          contactExternalId: "sub-99",
          content: "Hello test",
          source: "HUMAN",
        }),
      );
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integration.send_test_message" }),
      );
    });
  });

  describe("tenant isolation", () => {
    it("GET status is scoped to session organisation only", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");

      const res = await manychatGet();
      const json = await res.json();

      expect(mocks.messagingChannelFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organisationId: "org-a", provider: "manychat" },
        }),
      );
      expect(mocks.webhookEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organisationId: "org-a", provider: "manychat" },
        }),
      );
      expect(json.apiTokenStatus).toBe("Configured");
      expect(JSON.stringify(json)).not.toContain("tok");
    });

    it("send_test_message looks up contact within session org only", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: true,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.contactIdentifierFindFirst.mockResolvedValue(null);

      const res = await manychatPost(
        new Request("http://localhost/api/integrations/manychat", {
          method: "POST",
          body: JSON.stringify({
            action: "send_test_message",
            contactExternalId: "other-org-sub",
          }),
        }) as never,
      );

      expect(res.status).toBe(404);
      expect(mocks.contactIdentifierFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organisationId: "org-a" }),
        }),
      );
      expect(mocks.dispatchOutboundMessage).not.toHaveBeenCalled();
    });

    it("inactive org connection does not leak env token via getOrganisationManyChatApiToken", async () => {
      mocks.findUniqueIntegration.mockResolvedValue({
        id: "int-a",
        isActive: false,
        credentials: [{ keyName: "api_token", encryptedValue: "enc:tok" }],
      });
      mocks.decryptSecret.mockReturnValue("tok");
      mocks.getEnv.mockReturnValue({ MANYCHAT_API_TOKEN: "env-token" });

      expect(await getOrganisationManyChatApiToken("org-a")).toBeNull();
      const state = await getOrganisationManyChatConnectionState("org-a");
      expect(state.isActive).toBe(false);
      expect(state.hasStoredApiToken).toBe(true);
    });
  });

  describe("messaging channel audit + isActive", () => {
    it("audits create with isActive", async () => {
      const { prisma } = await import("@/lib/db");
      (prisma.messagingChannel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.messagingChannel.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "ch-new",
        provider: "manychat",
        externalId: "page-9",
        displayName: "Page",
        isActive: false,
      });

      const res = await channelsPost(
        new Request("http://localhost/api/messaging-channels", {
          method: "POST",
          body: JSON.stringify({
            provider: "manychat",
            externalId: "page-9",
            displayName: "Page",
            isActive: false,
          }),
        }),
      );
      const json = await res.json();

      expect(json.channel.isActive).toBe(false);
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "messaging_channel.created",
          entityId: "ch-new",
          metadata: expect.objectContaining({ isActive: false }),
        }),
      );
    });

    it("audits update with isActive", async () => {
      const { prisma } = await import("@/lib/db");
      (prisma.messagingChannel.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "ch-1",
        organisationId: "org-a",
        isActive: true,
      });
      (prisma.messagingChannel.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "ch-1",
        provider: "manychat",
        externalId: "page-1",
        displayName: "Page",
        isActive: false,
      });

      const res = await channelsPost(
        new Request("http://localhost/api/messaging-channels", {
          method: "POST",
          body: JSON.stringify({
            id: "ch-1",
            provider: "manychat",
            externalId: "page-1",
            displayName: "Page",
            isActive: false,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "messaging_channel.updated",
          metadata: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });
});
