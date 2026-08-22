import { describe, expect, it } from "vitest";
import {
  assertKnowledgePromotionPolicy,
  formatPreferencesForContext,
} from "@/services/agent-memory";
import { clearToolRegistry, ensureBuiltinToolsRegistered, getTool, evaluateToolPolicy } from "@/kernel";

describe("assertKnowledgePromotionPolicy", () => {
  it("blocks ACTIVE status for from-ask drafts", () => {
    const r = assertKnowledgePromotionPolicy({
      category: "research",
      tags: ["from-ask", "draft"],
      status: "ACTIVE",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot be activated/i);
  });

  it("forces INACTIVE for research/from-ask without ACTIVE", () => {
    const r = assertKnowledgePromotionPolicy({
      category: "research",
      tags: ["from-ask"],
      status: undefined,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.forcedStatus).toBe("INACTIVE");
  });

  it("allows normal knowledge docs", () => {
    const r = assertKnowledgePromotionPolicy({
      category: "playbook",
      tags: ["ops"],
      status: "ACTIVE",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.forcedStatus).toBeUndefined();
  });
});

describe("formatPreferencesForContext", () => {
  it("returns null when empty", () => {
    expect(formatPreferencesForContext({})).toBeNull();
  });

  it("formats tone and style", () => {
    const text = formatPreferencesForContext({
      tone: "direct",
      operatingStyle: "concise briefs",
    });
    expect(text).toContain("Tone preference: direct");
    expect(text).toContain("Operating style: concise briefs");
  });
});

describe("memory.retrieve kernel tool", () => {
  it("is registered as read/allow", () => {
    clearToolRegistry();
    ensureBuiltinToolsRegistered();
    expect(getTool("memory.retrieve")?.risk).toBe("read");
    const d = evaluateToolPolicy("memory.retrieve", { organisationId: "org_1" });
    expect(d.effect).toBe("allow");
  });
});
