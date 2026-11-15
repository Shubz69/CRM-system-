/**
 * Go-live, Settings and Integrations only call the endpoints the signed-in role may use.
 * Rows a role can't check say "ask a workspace owner or admin" instead of "couldn't load",
 * and env var names on /integrations are for platform admins only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ASK_OWNER_TO_CHECK,
  bookingCheck,
  businessProfileCheck,
  goLiveAccess,
  instagramCheck,
  messagingRulesCheck,
  NO_ACCESS,
  qualificationCheck,
  scoringCheck,
} from "@/app/(app)/settings/go-live/checklist";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/** The permission the route's GET handler requires (first requirePermission after `GET`). */
function getPermission(routeFile: string): string | null {
  const source = read(routeFile);
  const get = source.indexOf("export async function GET");
  const match = /requirePermission\("([a-z:]+)"\)/.exec(source.slice(get));
  return get >= 0 && match ? match[1]! : null;
}

describe("goLiveAccess mirrors the API routes", () => {
  it("uses the same permissions the GET routes check", () => {
    expect(getPermission("src/app/api/messaging-channels/route.ts")).toBe("settings:read");
    expect(getPermission("src/app/api/integrations/zernio/route.ts")).toBe("settings:read");
    expect(getPermission("src/app/api/integrations/manychat/route.ts")).toBe("integrations:manage");
    expect(getPermission("src/app/api/agent/route.ts")).toBe("agent:manage");
    expect(getPermission("src/app/api/qualification-fields/route.ts")).toBe("agent:manage");
    expect(getPermission("src/app/api/business-context/route.ts")).toBe("insights:read");
    expect(read("src/app/api/autopilot/route.ts")).toMatch(
      /export async function PATCH[\s\S]*?requirePermission\("agent:manage"\)/,
    );
  });

  it("owners and admins may use every source; a sales agent only the business profile", () => {
    const all = {
      channels: true,
      socialAccounts: true,
      manychat: true,
      agent: true,
      businessProfile: true,
      goLive: true,
    };
    for (const role of ["SUPER_ADMIN", "OWNER", "ADMINISTRATOR"] as MemberRole[]) {
      expect(goLiveAccess(role)).toEqual(all);
    }
    expect(goLiveAccess("SALES_AGENT")).toEqual({
      channels: false,
      socialAccounts: false,
      manychat: false,
      agent: false,
      businessProfile: true,
      goLive: false,
    });
    expect(goLiveAccess("MANAGER")).toMatchObject({
      channels: true,
      socialAccounts: true,
      manychat: false,
      agent: false,
      goLive: false,
    });
    expect(Object.values(goLiveAccess(null)).some(Boolean)).toBe(false);
  });
});

describe("go-live rows the role can't check", () => {
  const restricted = { status: "restricted", detail: ASK_OWNER_TO_CHECK };

  it("ask an owner or admin instead of saying the data couldn't load", () => {
    expect(qualificationCheck({ agent: NO_ACCESS, qualificationFieldCount: NO_ACCESS })).toMatchObject(
      restricted,
    );
    expect(scoringCheck(NO_ACCESS)).toMatchObject(restricted);
    expect(messagingRulesCheck(NO_ACCESS)).toMatchObject(restricted);
    expect(bookingCheck({ agent: NO_ACCESS, defaultBookingUrlConfigured: false })).toMatchObject(
      restricted,
    );
    expect(
      businessProfileCheck({ organisationName: "Acme", productCount: NO_ACCESS, audienceCount: NO_ACCESS }),
    ).toMatchObject(restricted);
    expect(
      instagramCheck({ manychat: NO_ACCESS, channels: NO_ACCESS, zernioInstagram: NO_ACCESS }),
    ).toMatchObject(restricted);
  });

  it("keeps 'couldn't load' for real failures", () => {
    expect(scoringCheck(undefined).detail).toMatch(/Couldn't load/);
    expect(instagramCheck({ manychat: null, channels: null, zernioInstagram: null }).detail).toMatch(
      /Couldn't load/,
    );
  });

  it("checks what a role without ManyChat access can see, and says who can fix the rest", () => {
    const manyChatChannel = { provider: "manychat", isActive: true, instagramUsername: "salon" };
    expect(
      instagramCheck({
        manychat: NO_ACCESS,
        channels: [manyChatChannel],
        zernioInstagram: { connected: false },
      }),
    ).toMatchObject({ status: "restricted", detail: expect.stringMatching(/ask a workspace owner or admin/) });
    expect(
      instagramCheck({
        manychat: NO_ACCESS,
        channels: [{ provider: "meta_instagram", isActive: true, instagramUsername: "salon" }],
        zernioInstagram: { connected: false },
      }),
    ).toMatchObject({ status: "ready", detail: "Receiving DMs via Instagram (Meta) (@salon)" });
    expect(
      instagramCheck({ manychat: NO_ACCESS, channels: [], zernioInstagram: { connected: false } }),
    ).toMatchObject({
      status: "needs_attention",
      detail: expect.stringMatching(/ask a workspace owner or admin to connect/),
    });
  });
});

describe("pages gate role-restricted calls and controls", () => {
  it("go-live only fetches gated endpoints through the role check", () => {
    const page = read("src/app/(app)/settings/go-live/page.tsx");
    for (const [flag, url] of [
      ["channels", "/api/messaging-channels"],
      ["agent", "/api/agent"],
      ["agent", "/api/qualification-fields"],
      ["businessProfile", "/api/business-context"],
      ["socialAccounts", "/api/integrations/zernio"],
      ["manychat", "/api/integrations/manychat"],
    ]) {
      expect(page).toContain(`fetchIf(can.${flag}, "${url}")`);
    }
    expect(page).toMatch(/access\.goLive \?/);
  });

  it("settings skips calls the role can't make and matches the timezone roles of PATCH /api/settings", () => {
    const page = read("src/app/(app)/settings/page.tsx");
    expect(page).toContain('access.readSettings ? fetch("/api/messaging-channels") : null');
    expect(page).toContain('access.manageMembers ? fetch("/api/workspace/members") : null');
    expect(page).toContain('access.readSettings ? fetch("/api/integrations/zernio") : null');
    const route = read("src/app/api/settings/route.ts");
    const roles = (src: string) =>
      /TIMEZONE_EDIT_ROLES[^=]*= new Set\(\[([^\]]+)\]\)/.exec(src)?.[1]?.replace(/\s/g, "");
    expect(roles(page)).toBe(roles(route));
  });

  it("integrations shows env var names to platform admins only and gates the messaging forms", () => {
    const client = read("src/app/(app)/integrations/integrations-client.tsx");
    expect(client).toMatch(/\{isPlatformAdmin \? \(\s*<p[^>]*>\s*Native TikTok Connect[\s\S]*?TIKTOK_CLIENT_KEY/);
    expect(client).toContain("TikTok isn&apos;t available yet.");
    expect(client).toMatch(/if \(!canManageIntegrations\) \{\s*setStatus\(null\);\s*return;/);
    expect(client).toMatch(/if \(!canViewSocial\) \{\s*setSocialAccounts\(null\);\s*return;/);
    expect(client).toMatch(/\{canManageIntegrations \? \(\s*<>\s*<section\s+id=\{MANYCHAT_SETUP_ID\}/);
  });
});
