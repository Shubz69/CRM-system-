import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as metaInstagramConnectGet } from "@/app/api/integrations/meta-instagram/connect/route";
import { GET as metaInstagramWebhookGet, POST as metaInstagramWebhookPost } from "@/app/api/webhooks/meta/instagram/route";
import { POST as manyChatWebhookPost } from "@/app/api/webhooks/manychat/route";
import {
  META_INSTAGRAM_DEV_VERIFY_TOKEN,
  MetaInstagramNotConfiguredError,
  assertMetaInstagramMessagingConfigured,
  assertProductionSecretsConfigured,
  assertWebhookSecretsConfigured,
  metaInstagramNotConfiguredResponse,
  resetEnvCache,
} from "@/lib/env";
import { handleBookingWebhook } from "@/services/booking-webhook";

vi.mock("@/lib/session", () => ({
  requirePermission: async () => ({ organisationId: "org-a", userId: "user-a" }),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const KEYS = [
  "ENCRYPTION_KEY",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "MANYCHAT_WEBHOOK_SECRET",
  "BOOKING_WEBHOOK_SECRET",
  "META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_INSTAGRAM_MESSAGING_REDIRECT_URI",
  "APP_URL",
] as const;

const original: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

function snapshotEnv() {
  for (const key of KEYS) original[key] = process.env[key];
}

function restoreEnv() {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

function setMandatoryGlobalProductionSecrets() {
  process.env.NODE_ENV = "production";
  process.env.ENCRYPTION_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.AUTH_SECRET = "production-auth-secret-ok";
  process.env.NEXTAUTH_SECRET = "production-auth-secret-ok";
  process.env.MANYCHAT_WEBHOOK_SECRET = "rotated-manychat-webhook-secret";
  process.env.BOOKING_WEBHOOK_SECRET = "rotated-booking-webhook-secret";
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  process.env.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN = META_INSTAGRAM_DEV_VERIFY_TOKEN;
  resetEnvCache();
}

describe("Optional Meta Instagram must not take down global runtime", () => {
  snapshotEnv();

  afterEach(() => {
    restoreEnv();
  });

  it("production + Meta variables absent → global secret validation succeeds", () => {
    setMandatoryGlobalProductionSecrets();
    expect(() => assertWebhookSecretsConfigured()).not.toThrow();
    expect(() => assertProductionSecretsConfigured()).not.toThrow();
  });

  it("still hard-fails globally on unrotated ManyChat / booking / encryption / auth secrets", () => {
    setMandatoryGlobalProductionSecrets();
    process.env.MANYCHAT_WEBHOOK_SECRET = "dev-manychat-webhook-secret";
    resetEnvCache();
    expect(() => assertProductionSecretsConfigured()).toThrow(/MANYCHAT_WEBHOOK_SECRET/);

    setMandatoryGlobalProductionSecrets();
    process.env.BOOKING_WEBHOOK_SECRET = "dev-booking-webhook-secret";
    resetEnvCache();
    expect(() => assertProductionSecretsConfigured()).toThrow(/BOOKING_WEBHOOK_SECRET/);

    setMandatoryGlobalProductionSecrets();
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    resetEnvCache();
    expect(() => assertProductionSecretsConfigured()).toThrow(/ENCRYPTION_KEY/);

    setMandatoryGlobalProductionSecrets();
    process.env.AUTH_SECRET = "dev-only-auth-secret-change-me";
    process.env.NEXTAUTH_SECRET = "dev-only-auth-secret-change-me";
    resetEnvCache();
    expect(() => assertProductionSecretsConfigured()).toThrow(/AUTH_SECRET/);
  });

  it("Meta variables absent → ManyChat webhook does not fail because Meta is unconfigured", async () => {
    setMandatoryGlobalProductionSecrets();
    const req = new Request("http://localhost/api/webhooks/manychat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await manyChatWebhookPost(req as never);
    expect(res.status).not.toBe(500);
    expect(res.status).toBeLessThan(500);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toMatch(/META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN/);
    expect(JSON.stringify(body)).not.toMatch(/META_NOT_CONFIGURED/);
  });

  it("Meta variables absent → booking webhook does not fail because Meta is unconfigured", async () => {
    setMandatoryGlobalProductionSecrets();
    const req = new Request("http://localhost/api/webhooks/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await handleBookingWebhook(req as never);
    expect(res.status).not.toBe(500);
    expect(res.status).toBeLessThan(500);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toMatch(/META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN/);
    expect(JSON.stringify(body)).not.toMatch(/META_NOT_CONFIGURED/);
  });

  it("Meta OAuth/connect fails closed with META_NOT_CONFIGURED", async () => {
    setMandatoryGlobalProductionSecrets();
    expect(() => assertMetaInstagramMessagingConfigured()).toThrow(MetaInstagramNotConfiguredError);
    try {
      assertMetaInstagramMessagingConfigured();
    } catch (error) {
      expect(error).toBeInstanceOf(MetaInstagramNotConfiguredError);
      expect((error as MetaInstagramNotConfiguredError).code).toBe("META_NOT_CONFIGURED");
    }

    const res = await metaInstagramConnectGet();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("META_NOT_CONFIGURED");
    expect(json.health).toBe("NOT_CONFIGURED");
  });

  it("Meta webhook verification fails safely if Meta verify configuration is missing", async () => {
    setMandatoryGlobalProductionSecrets();
    const getRes = await metaInstagramWebhookGet(
      new Request(
        "http://localhost/api/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc",
      ) as never,
    );
    expect(getRes.status).toBe(503);
    const getJson = await getRes.json();
    expect(getJson.code).toBe("META_NOT_CONFIGURED");

    const postRes = await metaInstagramWebhookPost(
      new Request("http://localhost/api/webhooks/meta/instagram", {
        method: "POST",
        body: "{}",
      }) as never,
    );
    expect(postRes.status).toBe(503);
    const postJson = await postRes.json();
    expect(postJson.code).toBe("META_NOT_CONFIGURED");
  });

  it("Meta provider configured with valid secrets → normal Meta webhook verify path works", async () => {
    setMandatoryGlobalProductionSecrets();
    process.env.INSTAGRAM_APP_ID = "ig-app-id";
    process.env.INSTAGRAM_APP_SECRET = "ig-app-secret";
    process.env.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN = "rotated-meta-verify-token";
    process.env.META_INSTAGRAM_MESSAGING_REDIRECT_URI =
      "https://example.com/api/integrations/meta-instagram/callback";
    process.env.APP_URL = "https://example.com";
    resetEnvCache();

    expect(() => assertProductionSecretsConfigured()).not.toThrow();
    expect(() => assertMetaInstagramMessagingConfigured()).not.toThrow();

    const res = await metaInstagramWebhookGet(
      new Request(
        "http://localhost/api/webhooks/meta/instagram?hub.mode=subscribe&hub.verify_token=rotated-meta-verify-token&hub.challenge=challenge-ok",
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("challenge-ok");
  });

  it("metaInstagramNotConfiguredResponse uses META_NOT_CONFIGURED", async () => {
    const res = metaInstagramNotConfiguredResponse();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "META_NOT_CONFIGURED",
      health: "NOT_CONFIGURED",
    });
  });
});
