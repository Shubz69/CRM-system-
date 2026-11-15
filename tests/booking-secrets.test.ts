import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  integrationFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { integration: { findUnique: mocks.integrationFindUnique } },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ BOOKING_WEBHOOK_SECRET: "shared-booking-secret" }),
}));
vi.mock("@/lib/crypto", () => ({
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
  encryptSecret: (value: string) => `enc:${value}`,
}));

import {
  matchesSharedBookingSecret,
  verifyBookingWebhookSecret,
} from "@/services/booking-secrets";

function withOrgSecret(secret: string | null) {
  mocks.integrationFindUnique.mockResolvedValue(
    secret ? { credentials: [{ keyName: "webhook_secret", encryptedValue: `enc:${secret}` }] } : null,
  );
}

describe("booking webhook secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BOOKING_WEBHOOK_REQUIRE_ORG_SECRET;
  });
  afterEach(() => {
    delete process.env.BOOKING_WEBHOOK_REQUIRE_ORG_SECRET;
  });

  it("a workspace with its own secret accepts only that secret", async () => {
    withOrgSecret("bk_glow");
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_glow", presented: "bk_glow" }),
    ).resolves.toEqual({ ok: true, source: "organisation" });
    // The shared secret (known to every tenant) can no longer write into this workspace.
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_glow", presented: "shared-booking-secret" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("workspaces that haven't generated one keep working with the shared secret", async () => {
    withOrgSecret(null);
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_old", presented: "shared-booking-secret" }),
    ).resolves.toEqual({ ok: true, source: "global" });
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_old", presented: "wrong" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("BOOKING_WEBHOOK_REQUIRE_ORG_SECRET=true turns the shared secret off", async () => {
    process.env.BOOKING_WEBHOOK_REQUIRE_ORG_SECRET = "true";
    withOrgSecret(null);
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_old", presented: "shared-booking-secret" }),
    ).resolves.toMatchObject({ ok: false });
    expect(matchesSharedBookingSecret("shared-booking-secret")).toBe(false);
  });

  it("an empty secret is never accepted", async () => {
    withOrgSecret(null);
    await expect(
      verifyBookingWebhookSecret({ organisationId: "org_old", presented: "" }),
    ).resolves.toMatchObject({ ok: false });
    expect(matchesSharedBookingSecret("")).toBe(false);
  });
});
