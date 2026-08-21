import { describe, expect, it, beforeEach } from "vitest";
import {
  clearToolRegistry,
  ensureBuiltinToolsRegistered,
  evaluateToolPolicy,
  getTool,
  listTools,
  registerTool,
} from "@/kernel";

describe("Agent Kernel tool registry", () => {
  beforeEach(() => {
    clearToolRegistry();
  });

  it("registers builtin tools idempotently", () => {
    ensureBuiltinToolsRegistered();
    ensureBuiltinToolsRegistered();
    const tools = listTools();
    expect(tools.length).toBeGreaterThanOrEqual(5);
    expect(getTool("sources.search")?.risk).toBe("read");
    expect(getTool("social.publish")?.risk).toBe("publish");
  });

  it("allows read tools automatically", () => {
    ensureBuiltinToolsRegistered();
    const d = evaluateToolPolicy("sources.search", {
      organisationId: "org_1",
    });
    expect(d.effect).toBe("allow");
  });

  it("requires approval for outbound messaging", () => {
    ensureBuiltinToolsRegistered();
    const d = evaluateToolPolicy("messaging.send", {
      organisationId: "org_1",
    });
    expect(d.effect).toBe("require_approval");
  });

  it("requires approval for publish", () => {
    ensureBuiltinToolsRegistered();
    const d = evaluateToolPolicy("social.publish", {
      organisationId: "org_1",
    });
    expect(d.effect).toBe("require_approval");
  });

  it("denies unknown tools", () => {
    const d = evaluateToolPolicy("not.a.tool", { organisationId: "org_1" });
    expect(d.effect).toBe("deny");
  });

  it("respects autopilot disabled for mapped capabilities", () => {
    registerTool({
      name: "messaging.send",
      version: "1.0.0",
      description: "send",
      risk: "outbound_message",
      costClass: "metered",
    });
    const d = evaluateToolPolicy("messaging.send", {
      organisationId: "org_1",
      autopilotModes: { followUps: "disabled" },
    });
    expect(d.effect).toBe("deny");
  });
});
