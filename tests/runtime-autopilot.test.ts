import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  parseAutopilotConfig,
} from "@/lib/autopilot-config";
import { capabilityAllowsAuto, isAutopilotOperating } from "@/services/autopilot";

describe("autopilot config", () => {
  it("defaults are sensible", () => {
    expect(DEFAULT_AUTOPILOT_CONFIG.aiResponses).toBe("automatic");
    expect(DEFAULT_AUTOPILOT_CONFIG.followUps).toBe("approval_required");
    expect(DEFAULT_AUTOPILOT_CONFIG.booking).toBe("automatic");
  });

  it("parses partial overrides", () => {
    const cfg = parseAutopilotConfig({ booking: "approval_required", unknown: "x" });
    expect(cfg.booking).toBe("approval_required");
    expect(cfg.aiResponses).toBe("automatic");
  });

  it("LIVE operates for any provider; TEST only simulator", () => {
    expect(isAutopilotOperating("LIVE", { provider: "manychat" })).toBe(true);
    expect(isAutopilotOperating("TEST", { provider: "manychat" })).toBe(false);
    expect(isAutopilotOperating("TEST", { provider: "simulator" })).toBe(true);
    expect(isAutopilotOperating("OFF")).toBe(false);
    expect(isAutopilotOperating("PAUSED")).toBe(false);
  });

  it("capability gates", () => {
    const cfg = parseAutopilotConfig({ aiResponses: "disabled" });
    expect(capabilityAllowsAuto(cfg, "aiResponses")).toBe(false);
    expect(capabilityAllowsAuto(cfg, "qualification")).toBe(true);
  });
});
