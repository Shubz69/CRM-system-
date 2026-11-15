/**
 * Go-live: Instagram is ready when ANY inbound Instagram path works (ManyChat, Meta Instagram,
 * or a Zernio-connected account) — not only Zernio. And /integrations reads the
 * `linkingAvailable` flag the Zernio API actually returns, so Connect isn't always disabled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instagramCheck } from "@/app/(app)/settings/go-live/checklist";

const manyChatChannel = {
  provider: "manychat",
  isActive: true,
  displayName: "Salon IG",
  instagramUsername: "salon_demo",
};

describe("go-live instagramCheck", () => {
  it("is ready via ManyChat with an active channel and the workspace webhook secret (no Zernio)", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: true, apiTokenConfigured: true, channels: [manyChatChannel] },
      channels: [manyChatChannel],
      zernioInstagram: { connected: false },
    });
    expect(check.status).toBe("ready");
    expect(check.detail).toBe("Receiving DMs via ManyChat (@salon_demo)");
  });

  it("still passes for ManyChat without an API token, but says replies need it", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: true, apiTokenConfigured: false, channels: [manyChatChannel] },
      channels: null,
      zernioInstagram: null,
    });
    expect(check.status).toBe("ready");
    expect(check.detail).toMatch(/ManyChat API token/);
  });

  it("needs attention when the ManyChat channel has no webhook secret (DMs would be rejected)", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: false, channels: [manyChatChannel] },
      channels: [manyChatChannel],
      zernioInstagram: { connected: false },
    });
    expect(check.status).toBe("needs_attention");
    expect(check.detail).toMatch(/no webhook secret/);
  });

  it("needs attention when the secret is set but no ManyChat channel is active", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: true, channels: [{ ...manyChatChannel, isActive: false }] },
      channels: [],
      zernioInstagram: { connected: false },
    });
    expect(check.status).toBe("needs_attention");
    expect(check.detail).toMatch(/no active channel/);
  });

  it("is ready via an active Meta Instagram channel", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: false, channels: [] },
      channels: [
        { provider: "meta_instagram", isActive: true, displayName: "@salon", instagramUsername: "salon" },
      ],
      zernioInstagram: { connected: false },
    });
    expect(check).toMatchObject({ status: "ready", detail: "Receiving DMs via Instagram (Meta) (@salon)" });
  });

  it("ignores a disconnected (inactive) Meta Instagram channel", () => {
    const check = instagramCheck({
      manychat: { secretConfigured: false, channels: [] },
      channels: [{ provider: "meta_instagram", isActive: false, instagramUsername: "salon" }],
      zernioInstagram: { connected: false },
    });
    expect(check.status).toBe("needs_attention");
  });

  it("is ready via a Zernio-connected Instagram account and lists every working path", () => {
    expect(
      instagramCheck({
        manychat: null,
        channels: null,
        zernioInstagram: { connected: true, username: "salon_demo", messaging: { directMessages: true } },
      }),
    ).toMatchObject({ status: "ready", detail: "Receiving DMs via Zernio (@salon_demo)" });

    const both = instagramCheck({
      manychat: { secretConfigured: true, apiTokenConfigured: true, channels: [manyChatChannel] },
      channels: [],
      zernioInstagram: { connected: true, username: "salon_demo" },
    });
    expect(both.detail).toBe("Receiving DMs via ManyChat (@salon_demo) · Zernio (@salon_demo)");
  });

  it("explains how to connect when nothing is set up, and when nothing could be loaded", () => {
    expect(
      instagramCheck({
        manychat: { secretConfigured: false, channels: [] },
        channels: [],
        zernioInstagram: { connected: false },
      }),
    ).toMatchObject({ status: "needs_attention", detail: expect.stringMatching(/No Instagram inbox connected/) });
    expect(
      instagramCheck({ manychat: null, channels: null, zernioInstagram: null }).detail,
    ).toMatch(/Couldn't load/);
  });
});

describe("integrations page Social Accounts wiring", () => {
  it("enables Connect from the linkingAvailable flag GET /api/integrations/zernio returns", () => {
    const client = readFileSync(
      join(process.cwd(), "src/app/(app)/integrations/integrations-client.tsx"),
      "utf8",
    );
    const api = readFileSync(join(process.cwd(), "src/app/api/integrations/zernio/route.ts"), "utf8");
    expect(api).toContain("linkingAvailable: isZernioConfigured()");
    expect(client).toMatch(/socialAccounts\?\.linkingAvailable \?\? socialAccounts\?\.serverConfigured/);
    // No button gates on the stale field directly any more.
    expect(client).not.toMatch(/!socialAccounts\?\.serverConfigured/);
    expect(client).toMatch(/disabled=\{busy \|\| !linkingAvailable\}/);
  });

  it("go-live checklist uses instagramCheck with ManyChat, channels and Zernio inputs", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/settings/go-live/page.tsx"), "utf8");
    // Fetched only for roles allowed to call it (see go-live-role-access.test.ts).
    expect(page).toContain('"/api/integrations/manychat"');
    expect(page).toContain("instagramCheck({");
    expect(page).not.toContain("instagramConnected");
  });
});
