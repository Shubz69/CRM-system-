import { describe, expect, it } from "vitest";
import { humanizeConnectionError } from "@/services/connection-tests";

describe("humanizeConnectionError", () => {
  it("explains rejected API keys without status codes", () => {
    const msg = humanizeConnectionError("OpenAI 401 Incorrect API key provided", "ai");
    expect(msg).toMatch(/API key was rejected/i);
    expect(msg).not.toMatch(/401/);
  });

  it("explains network failures for redis plainly", () => {
    const msg = humanizeConnectionError("connect ECONNREFUSED 127.0.0.1:6379", "redis");
    expect(msg).toMatch(/could not reach/i);
    expect(msg.toLowerCase()).not.toContain("econnrefused");
  });
});
