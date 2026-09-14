import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const clientPath = join(process.cwd(), "src/app/(app)/integrations/integrations-client.tsx");
const apiPath = join(process.cwd(), "src/app/api/integrations/manychat/route.ts");

describe("Integrations Messaging setup wiring", () => {
  it("renders Messaging setup with regenerate secret and test inbound", () => {
    const text = readFileSync(clientPath, "utf8");
    expect(text).toContain('const MANYCHAT_SETUP_ID = "messaging-setup"');
    expect(text).toContain("id={MANYCHAT_SETUP_ID}");
    expect(text).toContain("Messaging setup");
    expect(text).toContain("Regenerate secret");
    expect(text).toContain("Test inbound");
    expect(text).toContain("organisationId");
    expect(text).toContain("Rotate token");
    expect(text).toContain("Disconnect messaging");
    expect(text).toContain("Reconnect messaging");
    expect(text).toContain("Social Accounts");
    expect(text).toMatch(/loadSocialAccounts\(\),\s*loadMessaging\(\)/);
    expect(text).toContain("AUTH_REQUIRED");
    expect(text).toContain("First-run inbound checklist");
    expect(text).toContain("Regenerate secret");
    expect(text).not.toMatch(/\bManyChat\b/);
    expect(text).toContain("TIKTOK_CLIENT_KEY");
    expect(text).toContain("no invented login");
  });

  it("keeps Social Accounts as the first customer heading", () => {
    const text = readFileSync(clientPath, "utf8");
    const social = text.indexOf(">Social Accounts<");
    const messaging = text.indexOf(">Messaging setup<");
    expect(social).toBeGreaterThan(0);
    expect(messaging).toBeGreaterThan(social);
  });

  it("exposes manychat status API to workspace integrations:manage", () => {
    const text = readFileSync(apiPath, "utf8");
    expect(text).toContain('requirePermission("integrations:manage")');
    expect(text).not.toMatch(/requirePlatformAccess\(\)/);
    expect(text).toContain("organisationId: session.organisationId");
    expect(text).toContain("inboundAuthRequired");
    expect(text).toContain('inboundCapabilityStatus: inboundAuthRequired ? "AUTH_REQUIRED" : "CONNECTED"');
    expect(text).toContain("secretConfigured = Boolean(orgSecret)");
    expect(text).toContain('"regenerate_secret"');
    expect(text).toContain('"test_inbound"');
    expect(text).toContain("Cannot operate on another workspace");
  });
});
