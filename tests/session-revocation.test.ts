import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";

const state = vi.hoisted(() => ({
  fingerprint: "fp_new",
  isSuspended: false,
}));

vi.mock("@/lib/env", () => ({ getAuthSecret: () => "test-auth-secret-at-least-16" }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/services/active-workspace", () => ({
  resolveActiveWorkspaceForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/session-security", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session-security")>(
    "@/lib/session-security",
  );
  return {
    ...actual,
    loadSessionFingerprint: vi.fn(async () => ({
      fingerprint: state.fingerprint,
      passwordHash: "hash",
      isActive: true,
      isSuspended: state.isSuspended,
      deletedAt: null,
      activeOrganisationId: "org_1",
      mustChangePassword: false,
      isPlatformAdmin: false,
    })),
  };
});

import { authOptions } from "@/lib/auth";
import {
  sessionFingerprint,
  signSessionRefreshProof,
  verifySessionRefreshProof,
} from "@/lib/session-security";

type JwtArgs = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]>>[0];
const jwt = (args: Partial<JwtArgs>) =>
  authOptions.callbacks!.jwt!(args as JwtArgs) as Promise<JWT>;

function existingToken(pwFp?: string): JWT {
  return {
    id: "user_1",
    organisationId: "org_1",
    role: "OWNER",
    memberships: [],
    pwFp,
    workspaceCheckedAt: Date.now(),
  } as JWT;
}

describe("session fingerprints", () => {
  it("change when the password changes or an admin ends all sessions", () => {
    const base = sessionFingerprint("hash_a", null);
    expect(sessionFingerprint("hash_a", null)).toBe(base);
    expect(sessionFingerprint("hash_b", null)).not.toBe(base);
    expect(sessionFingerprint("hash_a", new Date("2026-11-15T10:00:00Z"))).not.toBe(base);
  });

  it("refresh proofs are bound to the user and fingerprint and expire after 5 minutes", () => {
    const now = Date.now();
    const proof = signSessionRefreshProof("user_1", "fp_new", now);
    expect(verifySessionRefreshProof(proof, "user_1", "fp_new", now + 1000)).toBe(true);
    expect(verifySessionRefreshProof(proof, "user_2", "fp_new", now)).toBe(false);
    expect(verifySessionRefreshProof(proof, "user_1", "fp_other", now)).toBe(false);
    expect(verifySessionRefreshProof(proof, "user_1", "fp_new", now + 6 * 60_000)).toBe(false);
    expect(verifySessionRefreshProof(`${now}.forged`, "user_1", "fp_new", now)).toBe(false);
    expect(verifySessionRefreshProof(undefined, "user_1", "fp_new", now)).toBe(false);
  });
});

describe("JWT revocation", () => {
  beforeEach(() => {
    state.fingerprint = "fp_new";
    state.isSuspended = false;
  });

  it("keeps a token whose fingerprint is current", async () => {
    const token = await jwt({ token: existingToken("fp_new") });
    expect(token.id).toBe("user_1");
  });

  it("revokes a token issued before a password change", async () => {
    const token = await jwt({ token: existingToken("fp_old") });
    expect(token.id).toBe("");
  });

  it("a bare session update() from a stolen cookie cannot adopt the new fingerprint", async () => {
    const token = await jwt({ token: existingToken("fp_old"), trigger: "update", session: {} });
    expect(token.id).toBe("");
  });

  it("the browser that changed the password stays signed in with its proof", async () => {
    const sessionRefreshProof = signSessionRefreshProof("user_1", "fp_new");
    const token = await jwt({
      token: existingToken("fp_old"),
      trigger: "update",
      session: { mustChangePassword: false, sessionRefreshProof },
    });
    expect(token.id).toBe("user_1");
    expect(token.pwFp).toBe("fp_new");
  });

  it("tokens from before fingerprints existed sign in again once", async () => {
    const token = await jwt({ token: existingToken(undefined) });
    expect(token.id).toBe("");
  });

  it("a suspended user's token is revoked", async () => {
    state.isSuspended = true;
    const token = await jwt({ token: existingToken("fp_new") });
    expect(token.id).toBe("");
  });
});
