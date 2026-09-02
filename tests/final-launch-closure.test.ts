import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRole, SocialConnectionStatus, SocialPlatform } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prismaMocks = vi.hoisted(() => ({
  zernioProfile: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  socialConnection: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  organisationPreference: {
    findUnique: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "pref",
      ...args.create,
    })),
  },
  organisationAiBudget: {
    findUnique: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "budget",
      ...args.create,
    })),
  },
  aiExecution: {
    aggregate: vi.fn(async () => ({ _sum: { estimatedCost: 0 } })),
  },
  organisation: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  organisationInvitation: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  organisationMember: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  user: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  computeDecision: {
    create: vi.fn(async () => ({})),
  },
  computeAggregate: {
    upsert: vi.fn(async () => ({})),
  },
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)(prismaMocks);
    }
    return arg;
  }),
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMocks,
}));
vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/adapters/email", () => ({
  getEmailAdapter: () => ({
    send: vi.fn(async () => ({ ok: false, error: "SMTP not configured" })),
  }),
}));
vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      EMAIL_SMTP_URL: undefined,
      APP_URL: "http://localhost:3000",
      NEXTAUTH_URL: "http://localhost:3000",
    }),
  };
});

import {
  isZernioBackedConnection,
  listPublishTargets,
  syncPublishTargetsFromConnectedAccounts,
  zernioAccountIdFromConnection,
} from "@/services/publishing/publish-targets";
import { mergeDiscoveryCostLimits } from "@/services/social-prospecting/types";
import { computeHintsForAnswerMode } from "@/services/answer-modes/governor";
import { planCompute } from "@/services/compute-governor";
import { INVITE_ROLES, PLATFORM_INVITE_ROLES } from "@/services/workspace-onboarding";
import { toCustomerAiError } from "@/lib/customer-ai-errors";
import { SpendCapExceededError } from "@/services/ai-spend-gate";
import { assertOrgExpensiveRouteAllowed, OrgRateLimitError } from "@/lib/org-rate-limit";
import { isAiAutoSocialSendEnabled } from "@/lib/ai-auto-social-send";

vi.mock("@/services/agent-memory", () => ({
  getOrganisationPreferences: vi.fn(async () => ({})),
  setOrganisationPreference: vi.fn(async () => undefined),
}));

vi.mock("@/services/ai-router", () => ({
  getAiRouterConfig: vi.fn(async () => ({
    taskTiers: {},
    escalateOnLowConfidence: true,
    lowConfidenceThreshold: 0.5,
    highValueScoreThreshold: 70,
  })),
  selectModelForTask: vi.fn(() => ({
    tier: "default",
    model: "legacy-standard",
    reason: "default",
  })),
}));

vi.mock("@/services/intelligence-flags", () => ({
  isIntelligenceFlagEnabled: vi.fn(async () => true),
}));

describe("Final launch closure — publish targets + beta + spend + governor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPUTE_GOVERNOR_SHADOW_ONLY;
    delete process.env.AI_AUTO_SOCIAL_SEND;
  });

  it("syncs Zernio connected accounts into SocialConnection publish targets", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
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
      ],
      status: "CONNECTED",
      zernioProfileId: "zp_1",
      lastSyncAt: new Date(),
    });
    prismaMocks.socialConnection.upsert.mockImplementation(async (args: {
      create: Record<string, unknown>;
    }) => ({
      id: `sc_${args.create.externalAccountId}`,
      ...args.create,
      status: SocialConnectionStatus.ACTIVE,
    }));
    prismaMocks.socialConnection.findMany.mockResolvedValue([
      {
        id: "sc_zernio:ig_1",
        organisationId: "org_1",
        platform: SocialPlatform.INSTAGRAM,
        externalAccountId: "zernio:ig_1",
        displayName: "@acme",
        status: SocialConnectionStatus.ACTIVE,
        metadata: {
          provider: "ZERNIO",
          zernioNetwork: "instagram",
          zernioAccountId: "ig_1",
        },
      },
      {
        id: "sc_zernio:li_1",
        organisationId: "org_1",
        platform: SocialPlatform.LINKEDIN,
        externalAccountId: "zernio:li_1",
        displayName: "Acme Ltd",
        status: SocialConnectionStatus.ACTIVE,
        metadata: {
          provider: "ZERNIO",
          zernioNetwork: "linkedin",
          zernioAccountId: "li_1",
        },
      },
    ]);

    const targets = await listPublishTargets("org_1");
    expect(targets).toHaveLength(2);
    expect(targets[0]!.label).toBe("@acme");
    expect(targets[0]!.platform).toBe("INSTAGRAM");
    expect(targets.every((t) => t.provider === "ZERNIO")).toBe(true);
    expect(prismaMocks.socialConnection.upsert).toHaveBeenCalled();
  });

  it("identifies Zernio-backed connections without exposing provider to customers", () => {
    const conn = {
      externalAccountId: "zernio:abc",
      metadata: { provider: "ZERNIO", zernioAccountId: "abc" },
    };
    expect(isZernioBackedConnection(conn)).toBe(true);
    expect(zernioAccountIdFromConnection(conn)).toBe("abc");
  });

  it("clamps client prospecting cost args to server hard ceiling", () => {
    const raised = mergeDiscoveryCostLimits(50, {
      maxCandidates: 999,
      maxEstimatedCostCents: 50_000,
      maxExternalCalls: 999,
      maxSources: 999,
      maxResearchDepth: "DEEP",
    });
    expect(raised.maxCandidates).toBeLessThanOrEqual(20);
    expect(raised.maxEstimatedCostCents).toBeLessThanOrEqual(100);
    expect(raised.maxExternalCalls).toBeLessThanOrEqual(10);
    expect(raised.maxSources).toBeLessThanOrEqual(12);
  });

  it("maps answer modes to meaningfully distinct compute budgets", async () => {
    const quick = computeHintsForAnswerMode("QUICK");
    const executive = computeHintsForAnswerMode("EXECUTIVE");
    const action = computeHintsForAnswerMode("ACTION", "HIGH");
    const deep = computeHintsForAnswerMode("DEEP");

    expect(quick.toolBudget).toBeLessThan(executive.toolBudget!);
    expect(executive.toolBudget).toBeLessThanOrEqual(action.toolBudget!);
    expect(action.toolBudget).toBeLessThan(deep.toolBudget!);
    expect(quick.contextBudget).toBeLessThan(deep.contextBudget!);
    expect(quick.verificationBudget).toBe("FAST");
    expect(deep.verificationBudget).toBe("DEEP");

    const qPlan = await planCompute({
      organisationId: "org_1",
      taskType: "insight_generation",
      ...quick,
    });
    const dPlan = await planCompute({
      organisationId: "org_1",
      taskType: "insight_generation",
      ...deep,
    });
    expect(qPlan.governorMode).toBe("ECONOMY");
    expect(dPlan.governorMode).toBe("DEEP");
    expect((qPlan.estimatedCostCents ?? 0) < (dPlan.estimatedCostCents ?? 0)).toBe(true);
  });

  it("never invites platform-admin via workspace invite roles", () => {
    expect(INVITE_ROLES).not.toContain(MemberRole.SUPER_ADMIN);
    expect(PLATFORM_INVITE_ROLES).not.toContain(MemberRole.SUPER_ADMIN);
    expect(PLATFORM_INVITE_ROLES).toContain(MemberRole.OWNER);
    expect(INVITE_ROLES).not.toContain(MemberRole.OWNER);
  });

  it("maps spend-cap errors to customer-safe messages without vendor pricing", () => {
    const err = new SpendCapExceededError("cap 100¢ / 100¢", "org_1", 100, 100);
    const msg = toCustomerAiError(err);
    expect(msg).not.toMatch(/anthropic|openai|claude|¢|pricing/i);
    expect(msg.toLowerCase()).toContain("usage limit");
  });

  it("defaults AI auto social send disabled", () => {
    expect(isAiAutoSocialSendEnabled()).toBe(false);
  });

  it("enforces org expensive route rate limits", () => {
    const org = `org_rate_${Date.now()}`;
    for (let i = 0; i < 30; i++) {
      assertOrgExpensiveRouteAllowed(org, "ask");
    }
    expect(() => assertOrgExpensiveRouteAllowed(org, "ask")).toThrow(OrgRateLimitError);
  });

  it("content publish UI does not leak Zernio/Meta/ManyChat labels in customer page source", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/(app)/content/page.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/\bZernio\b|\bManyChat\b|\bAnthropic\b/);
  });

  it("syncPublishTargetsFromConnectedAccounts skips disconnected accounts", async () => {
    prismaMocks.zernioProfile.findUnique.mockResolvedValue({
      organisationId: "org_1",
      connectedAccounts: [
        { accountId: "x", platform: "instagram", status: "disconnected" },
      ],
      status: "DISCONNECTED",
      zernioProfileId: null,
      lastSyncAt: null,
    });
    prismaMocks.socialConnection.findMany.mockResolvedValue([]);
    await syncPublishTargetsFromConnectedAccounts("org_1");
    expect(prismaMocks.socialConnection.upsert).not.toHaveBeenCalled();
  });
});
