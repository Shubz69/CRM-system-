import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getEnv: vi.fn(),
  decryptSecret: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    integration: { findUnique: mocks.findUnique },
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mocks.getEnv(),
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret: (...args: unknown[]) => mocks.decryptSecret(...args),
  encryptSecret: (v: string) => `enc:${v}`,
}));

import { resolveMessagingSendCredential } from "@/services/messaging/credentials";

describe("resolveMessagingSendCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue({ MANYCHAT_API_TOKEN: "env-token" });
    mocks.decryptSecret.mockReturnValue("org-token");
  });

  it("prefers active organisation credential over env", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "int-a",
      isActive: true,
      credentials: [{ keyName: "api_token", encryptedValue: "cipher" }],
    });

    const result = await resolveMessagingSendCredential("org-a");
    expect(result).toEqual({
      token: "org-token",
      source: "organisation",
      connectionRef: "manychat:int-a",
    });
  });

  it("falls back to env only when no active org credential", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const result = await resolveMessagingSendCredential("org-a");
    expect(result).toEqual({
      token: "env-token",
      source: "env",
      connectionRef: "env:MANYCHAT_API_TOKEN",
    });
  });

  it("treats deactivated org connection as revoked (no env fallback)", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "int-a",
      isActive: false,
      credentials: [{ keyName: "api_token", encryptedValue: "cipher" }],
    });

    const result = await resolveMessagingSendCredential("org-a");
    expect(result.source).toBe("revoked");
    expect(result.token).toBeNull();
  });

  it("denies mismatched prepared connection ref (cross-org)", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "int-a",
      isActive: true,
      credentials: [{ keyName: "api_token", encryptedValue: "cipher" }],
    });

    const result = await resolveMessagingSendCredential("org-a", {
      preparedConnectionRef: "manychat:int-b",
    });
    expect(result).toEqual({
      token: null,
      source: "revoked",
      connectionRef: "manychat:int-b",
    });
  });

  it("revokes when prepared org connection is inactive", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "int-a",
      isActive: false,
      credentials: [{ keyName: "api_token", encryptedValue: "cipher" }],
    });

    const result = await resolveMessagingSendCredential("org-a", {
      preparedConnectionRef: "manychat:int-a",
    });
    expect(result.source).toBe("revoked");
    expect(result.token).toBeNull();
  });
});
