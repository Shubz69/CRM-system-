import { describe, expect, it } from "vitest";
import { createOAuthState, verifyOAuthState } from "@/lib/social-oauth-state";

describe("social OAuth state", () => {
  it("round-trips a valid state", () => {
    const state = createOAuthState({ organisationId: "org_1", userId: "user_1", platform: "instagram" });
    const payload = verifyOAuthState(state);
    expect(payload).not.toBeNull();
    expect(payload?.organisationId).toBe("org_1");
    expect(payload?.userId).toBe("user_1");
    expect(payload?.platform).toBe("instagram");
  });

  it("rejects a tampered state", () => {
    const state = createOAuthState({ organisationId: "org_1", userId: "user_1", platform: "instagram" });
    const tampered = `${state.slice(0, -2)}00`;
    expect(verifyOAuthState(tampered)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyOAuthState("not-a-real-state")).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
  });

  it("never encodes the same nonce twice", () => {
    const a = createOAuthState({ organisationId: "org_1", userId: "user_1", platform: "instagram" });
    const b = createOAuthState({ organisationId: "org_1", userId: "user_1", platform: "instagram" });
    expect(a).not.toBe(b);
  });
});
