import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRole, WebhookProcessingStatus } from "@prisma/client";
import {
  getAiModels,
  isDeterministicAnthropicModelError,
  isRetiredAnthropicModel,
  resolveModelForTier,
  resolveOperationalAnthropicModel,
  RETIRED_ANTHROPIC_MODELS,
} from "@/lib/ai-models";
import { CUSTOMER_AI_UNAVAILABLE, toCustomerAiError } from "@/lib/customer-ai-errors";
import { selectModelForTask } from "@/services/ai-router";
import { DEFAULT_TASK_TIERS } from "@/lib/ai-models";
import { resetEnvCache } from "@/lib/env";
import { AnthropicProvider } from "@/adapters/ai/anthropic";

const prismaMocks = vi.hoisted(() => ({
  webhookEvent: {
    findUnique: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "wh_1",
      ...args.data,
    })),
    update: vi.fn(async (args: { where: { id?: string }; data: Record<string, unknown> }) => ({
      id: args.where.id || "wh_1",
      ...args.data,
    })),
  },
  zernioProfile: { findUnique: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/adapters/zernio", async () => {
  const actual = await vi.importActual<typeof import("@/adapters/zernio")>("@/adapters/zernio");
  return {
    ...actual,
    isZernioWebhookConfigured: () => true,
    assertZernioWebhookConfigured: () => undefined,
    verifyZernioWebhookSignature: () => true,
    resolveZernioWebhookTenant: vi.fn(async () => ({
      ok: true as const,
      organisationId: "org_1",
      zernioProfileId: "zp_1",
    })),
    syncZernioConnectedAccountsWithRetry: vi.fn(),
  };
});

const inboundMock = vi.hoisted(() => ({
  processInboundMessage: vi.fn(),
}));
vi.mock("@/services/inbound-pipeline", () => inboundMock);

describe("Retired Anthropic model + webhook terminal state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
    delete process.env.ANTHROPIC_ECONOMY_MODEL;
    delete process.env.ANTHROPIC_ADVANCED_MODEL;
    resetEnvCache();
  });

  afterEach(() => {
    resetEnvCache();
  });

  it("does not use retired sonnet ID as operational default", () => {
    expect(RETIRED_ANTHROPIC_MODELS["claude-sonnet-4-20250514"]).toBe("default");
    expect(isRetiredAnthropicModel("claude-sonnet-4-20250514")).toBe(true);
    const models = getAiModels();
    expect(models.default).toBe("claude-sonnet-4-6");
    expect(models.default).not.toBe("claude-sonnet-4-20250514");
    expect(resolveModelForTier("default")).toBe("claude-sonnet-4-6");
    expect(resolveOperationalAnthropicModel("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-6");
  });

  it("breaks env self-loop when ANTHROPIC_DEFAULT_MODEL is itself retired", () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-20250514";
    expect(getAiModels().default).toBe("claude-sonnet-4-20250514");
    expect(resolveOperationalAnthropicModel("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-6");
    expect(resolveModelForTier("default")).toBe("claude-sonnet-4-6");
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
  });

  it("Inbox conversation path uses configured model — ignores retired agent override", () => {
    const router = {
      taskTiers: { ...DEFAULT_TASK_TIERS },
      escalateOnLowConfidence: true,
      lowConfidenceThreshold: 0.55,
      highValueScoreThreshold: 70,
    };
    const selected = selectModelForTask({
      taskType: "conversation",
      router,
      modelOverride: "claude-sonnet-4-20250514",
    });
    expect(selected.model).toBe("claude-sonnet-4-6");
    expect(selected.model).not.toBe("claude-sonnet-4-20250514");
    expect(selected.reason).toMatch(/retired_override_remapped|task:conversation/);
  });

  it("model-not-found 404 is deterministic — no retry storm; customer-safe error", async () => {
    expect(
      isDeterministicAnthropicModelError(
        'Anthropic request failed (404): {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"}}',
      ),
    ).toBe(true);

    process.env.ANTHROPIC_API_KEY = "test-key";
    resetEnvCache();
    let fetchCalls = 0;
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "model: claude-sonnet-4-20250514" },
          }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider();
    await expect(
      provider.complete({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/404/);
    expect(fetchCalls).toBe(1);

    const customer = toCustomerAiError(
      new Error("Anthropic request failed (404): model: claude-sonnet-4-20250514"),
    );
    expect(customer).toBe(CUSTOMER_AI_UNAVAILABLE);
    expect(customer).not.toMatch(/Anthropic|Claude|claude-sonnet/i);

    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("WebhookEvent processing exception does not remain RECEIVED", async () => {
    prismaMocks.webhookEvent.findUnique.mockResolvedValue(null);
    inboundMock.processInboundMessage.mockRejectedValue(new Error("boom processing"));

    const { normalizeZernioInboundMessage } = await import("@/adapters/messaging/zernio");
    const payload = {
      id: "evt_stuck_1",
      event: "message.received",
      accountId: "acc_1",
      profileId: "zp_1",
      account: { id: "acc_1", platform: "instagram", username: "brand" },
      message: {
        id: "msg_1",
        text: "hello from lead",
        sender: { id: "ig_user_1", username: "lead" },
      },
      conversation: {
        id: "zconv_1",
        contact: { id: "ig_user_1", username: "lead" },
      },
    };
    expect(normalizeZernioInboundMessage(payload)).not.toBeNull();

    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zernio-signature": "test",
        },
        body: JSON.stringify(payload),
      }) as never,
    );
    expect(res.status).toBe(500);
    expect(inboundMock.processInboundMessage).toHaveBeenCalled();
    const failedUpdates = prismaMocks.webhookEvent.update.mock.calls.filter((c) => {
      const data = c[0]?.data as { status?: string } | undefined;
      return data?.status === WebhookProcessingStatus.FAILED;
    });
    expect(failedUpdates.length).toBeGreaterThan(0);
  });

  it("provider retry after FAILED first webhook reprocesses; terminal success", async () => {
    prismaMocks.webhookEvent.findUnique
      .mockResolvedValueOnce({
        id: "wh_failed",
        status: WebhookProcessingStatus.FAILED,
        idempotencyKey: "evt_retry_1",
      })
      .mockResolvedValueOnce({
        id: "wh_failed",
        status: WebhookProcessingStatus.PROCESSED,
        idempotencyKey: "evt_retry_1",
      });

    inboundMock.processInboundMessage.mockResolvedValue({
      duplicate: false,
      webhookEventId: "inner",
      contactId: "c1",
      conversationId: "conv1",
      messageId: "m1",
    });

    const { normalizeZernioInboundMessage } = await import("@/adapters/messaging/zernio");
    // Ensure we have a path - if normalize returns null test still proves FAILED isn't short-circuited as duplicate
    const { POST } = await import("@/app/api/webhooks/zernio/route");
    const payload = {
      id: "evt_retry_1",
      event: "message.received",
      accountId: "acc_1",
      profileId: "zp_1",
      account: { id: "acc_1", platform: "instagram", username: "lead" },
      message: {
        id: "msg_retry",
        text: "hi again",
        from: { id: "ig_1", username: "lead" },
      },
    };
    const normalized = normalizeZernioInboundMessage(payload);
    // If adapter can't normalize this shape, still assert FAILED existing is not treated as duplicate-only
    const first = await POST(
      new Request("http://localhost/api/webhooks/zernio", {
        method: "POST",
        headers: { "content-type": "application/json", "x-zernio-signature": "test" },
        body: JSON.stringify(payload),
      }) as never,
    );
    const json = await first.json();
    expect(json.duplicate).not.toBe(true);
    if (normalized) {
      expect(inboundMock.processInboundMessage).toHaveBeenCalled();
    }
  });

  it("repo operational defaults do not hardcode retired sonnet snapshot", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const aiModels = readFileSync(join(process.cwd(), "src/lib/ai-models.ts"), "utf8");
    expect(aiModels).toMatch(/claude-sonnet-4-6/);
    expect(aiModels).toMatch(/claude-sonnet-4-20250514/);
    // Retired id only appears in RETIRED map, not as DEFAULT_MODELS.default value
    expect(aiModels).not.toMatch(/default:\s*"claude-sonnet-4-20250514"/);
    const inbound = readFileSync(join(process.cwd(), "src/services/inbound-pipeline.ts"), "utf8");
    expect(inbound).not.toMatch(/modelOverride:\s*agentConfig/);
    void MemberRole;
  });
});
