import { afterEach, describe, expect, it } from "vitest";
import { getPublicProviderCapabilityHealth } from "@/services/provider-capability-health";
import { resetEnvCache } from "@/lib/env";

describe("Public provider capability health", () => {
  afterEach(() => {
    resetEnvCache();
  });

  it("never returns secret values and distinguishes NOT_CONFIGURED vs CONFIGURED", () => {
    const snap = getPublicProviderCapabilityHealth();
    expect(snap.providers.length).toBeGreaterThan(5);
    const blob = JSON.stringify(snap);
    expect(blob).not.toMatch(/sk-|access_token|BEGIN |password|secret_value/i);

    for (const p of snap.providers) {
      expect([
        "NOT_CONFIGURED",
        "CONFIGURED",
        "CONNECTED",
        "DEGRADED",
        "REAUTH_REQUIRED",
        "DISCONNECTED",
      ]).toContain(p.status);
    }

    const meta = snap.providers.find((p) => p.id === "meta_instagram");
    expect(meta).toBeTruthy();
    // Env-only snapshot must not claim CONNECTED without org OAuth context
    expect(meta!.status).not.toBe("CONNECTED");
    expect(meta!.liveConnectionAware).toBe(false);
  });

  it("GET /api/health/providers stays public-safe", async () => {
    const { GET } = await import("@/app/api/health/providers/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.providers?.capabilities)).toBe(true);
    expect(json.providers?.ai?.status === "CONFIGURED" || json.providers?.ai?.status === "NOT_CONFIGURED").toBe(
      true,
    );
    expect(JSON.stringify(json)).not.toMatch(/ANTHROPIC_API_KEY|INSTAGRAM_APP_SECRET|MANYCHAT_API_TOKEN|AYRSHARE_API_KEY/);
  });
});
