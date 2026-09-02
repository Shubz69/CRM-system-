import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemberRole } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roleHasPermission } from "@/lib/permissions";
import { resetEnvCache } from "@/lib/env";
import {
  assertCanStartSocialConnect,
  countActiveConnectedAccounts,
  LEGACY_UNLIMITED_POLICY,
  NEW_ORG_BETA_POLICY,
  normalizeSocialConnectionPolicy,
  setSocialConnectionPolicy,
} from "@/services/social-connection-policy";
import {
  CUSTOMER_AI_UNAVAILABLE,
  customerSafeAiHealth,
  isProviderLeakingMessage,
  toCustomerAiError,
} from "@/lib/customer-ai-errors";
import { resolveProviderPlatformCapability } from "@/services/social-prospecting/capabilities";
import { universalOutreachSurface } from "@/services/social-prospecting/provider-router";
import { buildCanonicalZernioNetworks } from "@/adapters/zernio";

const prismaMocks = vi.hoisted(() => ({
  organisationPreference: {
    findUnique: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "pref_1",
      ...args.create,
    })),
  },
  organisation: {
    findFirst: vi.fn(),
  },
  zernioProfile: {
    findUnique: vi.fn(),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  integration: {
    upsert: vi.fn(async () => ({ id: "int" })),
  },
  messagingChannel: {
    upsert: vi.fn(async () => ({ id: "ch" })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  aiExecution: {
    count: vi.fn(async () => 0),
    findMany: vi.fn(async () => []),
    aggregate: vi.fn(async () => ({ _avg: { latencyMs: 0 } })),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));

const sessionMocks = vi.hoisted(() => ({
  requirePlatformAccess: vi.fn(),
  requirePermission: vi.fn(),
  jsonError: (message: string, status = 400) =>
    Response.json({ error: message }, { status }),
}));

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return {
    ...actual,
    requirePlatformAccess: sessionMocks.requirePlatformAccess,
    requirePermission: sessionMocks.requirePermission,
    jsonError: sessionMocks.jsonError,
  };
});

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/services/ai-router", () => ({
  getAiRouterConfig: vi.fn(async () => ({
    taskTiers: {},
    escalateOnLowConfidence: true,
    lowConfidenceThreshold: 0.5,
    highValueScoreThreshold: 70,
  })),
  saveAiRouterConfig: vi.fn(async (x: unknown) => x),
}));

describe("Tester access + provider privacy + YouTube", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ZERNIO_API_KEY = "zk";
    process.env.AUTH_SECRET = "auth-secret-for-state-tests-32chars!!";
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.ZERNIO_API_KEY;
    resetEnvCache();
  });

  it("workspace roles cannot access platform admin permissions", () => {
    expect(roleHasPermission(MemberRole.OWNER, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.ADMINISTRATOR, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.SALES_AGENT, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.READ_ONLY, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.READ_ONLY, "integrations:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.SUPER_ADMIN, "platform:manage")).toBe(true);
  });

  it("workspace admin cannot access AI provider configuration API (403)", async () => {
    sessionMocks.requirePlatformAccess.mockRejectedValue(
      new Error("Forbidden: missing permission platform:manage"),
    );
    const { GET } = await import("@/app/api/admin/ai-router/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("platform admin can access AI provider configuration API", async () => {
    sessionMocks.requirePlatformAccess.mockResolvedValue({
      userId: "u_platform",
      organisationId: "org_platform",
      role: MemberRole.SUPER_ADMIN,
      isPlatformAdmin: true,
    });
    const { GET } = await import("@/app/api/admin/ai-router/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.primaryProvider).toBe("anthropic");
    expect(json.models).toBeTruthy();
  });

  it("workspace admin cannot change social connection quota (403)", async () => {
    sessionMocks.requirePlatformAccess.mockRejectedValue(
      new Error("Forbidden: missing permission platform:manage"),
    );
    const { PATCH } = await import("@/app/api/admin/social-connection-policy/route");
    const res = await PATCH(
      new Request("http://localhost/api/admin/social-connection-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organisationId: "org_1",
          maxConnectedSocialAccounts: 99,
        }),
      }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("platform admin can change social connection quota", async () => {
    sessionMocks.requirePlatformAccess.mockResolvedValue({
      userId: "u_platform",
      organisationId: "org_platform",
      role: MemberRole.SUPER_ADMIN,
      isPlatformAdmin: true,
    });
    prismaMocks.organisation.findFirst.mockResolvedValue({ id: "org_1" });
    prismaMocks.organisationPreference.findUnique.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/admin/social-connection-policy/route");
    const res = await PATCH(
      new Request("http://localhost/api/admin/social-connection-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organisationId: "org_1",
          maxConnectedSocialAccounts: 2,
          allowedNetworks: ["INSTAGRAM", "YOUTUBE"],
        }),
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.policy.maxConnectedSocialAccounts).toBe(2);
    expect(json.policy.allowedNetworks).toEqual(["INSTAGRAM", "YOUTUBE"]);
  });

  it("cross-org quota isolation — policies stored per organisationId", async () => {
    await setSocialConnectionPolicy({
      organisationId: "org_a",
      policy: {
        socialConnectionsEnabled: true,
        maxConnectedSocialAccounts: 1,
        allowedNetworks: ["INSTAGRAM"],
      },
    });
    expect(prismaMocks.organisationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organisationId_key: { organisationId: "org_a", key: "social_connection_policy" },
        },
      }),
    );
  });

  it("customer AI errors do not leak provider names", () => {
    expect(toCustomerAiError(new Error("ANTHROPIC_API_KEY is not configured"))).toBe(
      CUSTOMER_AI_UNAVAILABLE,
    );
    expect(toCustomerAiError("Claude unavailable")).toBe(CUSTOMER_AI_UNAVAILABLE);
    expect(toCustomerAiError("OpenAI 429")).toBe(CUSTOMER_AI_UNAVAILABLE);
    expect(isProviderLeakingMessage("Anthropic API key missing")).toBe(true);
    const health = customerSafeAiHealth(true);
    expect(JSON.stringify(health)).not.toMatch(/Claude|Anthropic|OpenAI/i);
    expect(health.label).toBe("Agent Desk intelligence");
  });

  it("customer UI source does not contain Claude/Anthropic/OpenAI/AI Provider", () => {
    const roots = [
      "src/app/(app)/integrations/integrations-client.tsx",
      "src/app/(app)/settings/page.tsx",
      "src/app/(app)/agent/page.tsx",
      "src/app/(app)/setup/page.tsx",
    ];
    for (const rel of roots) {
      const text = readFileSync(join(process.cwd(), rel), "utf8");
      expect(text).not.toMatch(/\bClaude\b/);
      expect(text).not.toMatch(/\bAnthropic\b/i);
      expect(text).not.toMatch(/\bOpenAI\b/);
      expect(text).not.toMatch(/AI Provider/);
      expect(text).not.toMatch(/Needs Setup/);
    }
  });

  it("YouTube DM is unsupported; outreach is Open + Copy", () => {
    expect(
      resolveProviderPlatformCapability({
        provider: "ZERNIO",
        network: "YOUTUBE",
        capability: "DIRECT_MESSAGES",
      }),
    ).toBe("UNSUPPORTED");
    const surface = universalOutreachSurface("YOUTUBE");
    expect(surface.openLabel).toBe("Open YouTube Channel");
    expect(surface.sendMessage).toBe(false);
    expect(surface.copyActions.some((a) => a.label.includes("Outreach"))).toBe(true);
  });

  it("canonical networks keep Instagram/LinkedIn/YouTube independent", () => {
    const nets = buildCanonicalZernioNetworks({
      profile: {
        status: "CONNECTED",
        zernioProfileId: "zp",
        lastSyncAt: new Date(),
        connectedAccounts: [
          { accountId: "ig", platform: "instagram", username: "ada", status: "connected" },
          { accountId: "yt", platform: "youtube", displayName: "Ada Channel", status: "connected" },
        ],
      },
    });
    expect(nets.instagram.status).toBe("CONNECTED");
    expect(nets.youtube.status).toBe("CONNECTED");
    expect(nets.youtube.displayName).toBe("Ada Channel");
    expect(nets.youtube.accountType).toBe("Channel");
    expect(nets.linkedin.status).toBe("DISCONNECTED");
  });

  it("legacy orgs without preference stay unlimited; new-org beta defaults to max 2", () => {
    expect(LEGACY_UNLIMITED_POLICY.maxConnectedSocialAccounts).toBeNull();
    expect(NEW_ORG_BETA_POLICY.maxConnectedSocialAccounts).toBe(2);
    expect(normalizeSocialConnectionPolicy(undefined).maxConnectedSocialAccounts).toBeNull();
  });

  it("quota blocks new connect but allows reconnect of existing network", async () => {
    prismaMocks.organisationPreference.findUnique.mockResolvedValue({
      value: {
        socialConnectionsEnabled: true,
        maxConnectedSocialAccounts: 1,
        allowedNetworks: ["INSTAGRAM", "LINKEDIN", "YOUTUBE"],
      },
    });
    const accounts = [{ platform: "instagram", status: "connected" }];
    const blocked = await assertCanStartSocialConnect({
      organisationId: "org_1",
      network: "YOUTUBE",
      connectedAccounts: accounts,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("SOCIAL_CONNECTION_QUOTA");
      expect(blocked.error).toMatch(/connected-account limit/i);
      expect(blocked.error).not.toMatch(/zernio/i);
    }

    const reconnect = await assertCanStartSocialConnect({
      organisationId: "org_1",
      network: "INSTAGRAM",
      connectedAccounts: accounts,
    });
    expect(reconnect.ok).toBe(true);
  });

  it("disabled social connections return safe unavailable state", async () => {
    prismaMocks.organisationPreference.findUnique.mockResolvedValue({
      value: {
        socialConnectionsEnabled: false,
        maxConnectedSocialAccounts: 2,
        allowedNetworks: ["INSTAGRAM"],
      },
    });
    const gate = await assertCanStartSocialConnect({
      organisationId: "org_1",
      network: "INSTAGRAM",
      connectedAccounts: [],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("SOCIAL_CONNECTIONS_DISABLED");
  });

  it("disconnect releases quota capacity", () => {
    const before = countActiveConnectedAccounts([
      { platform: "instagram", status: "connected" },
      { platform: "youtube", status: "connected" },
    ]);
    const after = countActiveConnectedAccounts([
      { platform: "instagram", status: "connected" },
      { platform: "youtube", status: "disconnected" },
    ]);
    expect(before).toBe(2);
    expect(after).toBe(1);
  });

  it("platform admin social policy helper requires platform permission (RBAC)", () => {
    expect(roleHasPermission(MemberRole.OWNER, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.ADMINISTRATOR, "workspaces:manage")).toBe(false);
  });

  it("customer-safe AI health omits vendor identity fields", () => {
    const health = customerSafeAiHealth(false);
    expect(health).toEqual({
      label: "Agent Desk intelligence",
      ready: false,
      status: "UNAVAILABLE",
    });
    expect(JSON.stringify(health)).not.toMatch(/Claude|Anthropic|OpenAI|api.?key/i);
  });
});
