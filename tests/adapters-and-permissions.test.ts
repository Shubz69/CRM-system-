import { describe, expect, it } from "vitest";
import { MockAiProvider } from "@/adapters/ai/mock";
import { analyseWithValidation, buildAgentSystemPrompt } from "@/adapters/ai";
import { MockManyChatAdapter, clearMockOutboundLog, mockOutboundLog } from "@/adapters/messaging";
import { roleHasPermission } from "@/lib/permissions";
import { MemberRole } from "@prisma/client";

describe("Mock AI provider", () => {
  it("returns valid structured analysis for a pricing message", async () => {
    const provider = new MockAiProvider();
    const result = await analyseWithValidation(provider, {
      systemPrompt: buildAgentSystemPrompt({
        brandTone: "professional",
        formality: "professional",
        responseLength: "medium",
        emojiUsage: "minimal",
        restrictedTopics: [],
        qualificationQuestions: ["What business do you run?"],
      }),
      conversationTranscript: "",
      knowledgeContext: "Pricing starts around £497/month.",
      leadMessage: "How much does it cost for my coaching business?",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.reply.length).toBeGreaterThan(10);
    expect(result.analysis.confidence).toBeGreaterThan(0.5);
  });

  it("flags handover when a human is requested", async () => {
    const provider = new MockAiProvider();
    const result = await analyseWithValidation(provider, {
      systemPrompt: "test",
      conversationTranscript: "",
      knowledgeContext: "",
      leadMessage: "Can I talk to a real person please?",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.should_handover).toBe(true);
  });
});

describe("Mock ManyChat adapter", () => {
  it("records outbound messages", async () => {
    clearMockOutboundLog();
    const adapter = new MockManyChatAdapter();
    const result = await adapter.sendMessage({
      organisationId: "org_1",
      contactExternalId: "sub_1",
      text: "Hello from AI",
    });
    expect(result.ok).toBe(true);
    expect(mockOutboundLog).toHaveLength(1);
    expect(mockOutboundLog[0]?.text).toBe("Hello from AI");
  });
});

describe("Permissions", () => {
  it("allows owners to manage integrations", () => {
    expect(roleHasPermission(MemberRole.OWNER, "integrations:manage")).toBe(true);
  });

  it("prevents read-only users from writing inbox", () => {
    expect(roleHasPermission(MemberRole.READ_ONLY, "inbox:write")).toBe(false);
  });
});
