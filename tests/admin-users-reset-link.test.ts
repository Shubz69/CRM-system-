import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  env: { APP_URL: "", NEXTAUTH_URL: "", EMAIL_SMTP_URL: "" } as Record<string, string>,
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  userUpdate: vi.fn(),
  tokenDeleteMany: vi.fn(),
  tokenCreate: vi.fn(),
  emailSend: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst, findMany: mocks.userFindMany, update: mocks.userUpdate },
    verificationToken: { deleteMany: mocks.tokenDeleteMany, create: mocks.tokenCreate },
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/adapters/email", () => ({ getEmailAdapter: () => ({ send: mocks.emailSend }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/session-security", () => ({ revokeAllSessions: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requirePlatformAccess: vi.fn(async () => ({
    userId: "admin_1",
    organisationId: "org_platform",
    isPlatformAdmin: true,
  })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/services/audit", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { GET, POST } from "@/app/api/admin/users/route";

function resetRequest() {
  return new NextRequest("http://localhost:3100/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "send_password_reset", userId: "u_1" }),
  });
}

describe("admin password reset hands the link to the admin when email is off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env = { APP_URL: "", NEXTAUTH_URL: "", EMAIL_SMTP_URL: "" };
    mocks.userFindFirst.mockResolvedValue({ id: "u_1", email: "u@x.test", memberships: [] });
  });

  it("returns the one-time link (built from the request origin) when no email is configured", async () => {
    const res = await POST(resetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.emailed).toBe(false);
    expect(json.resetUrl).toMatch(/^http:\/\/localhost:3100\/reset-password\?token=[0-9a-f]{64}$/);
    expect(mocks.emailSend).not.toHaveBeenCalled();
    // The stored token is the hash of the link's token, never the raw value.
    const raw = new URL(json.resetUrl).searchParams.get("token");
    expect(mocks.tokenCreate.mock.calls[0]![0].data.token).not.toBe(raw);
  });

  it("does not return the link when it was emailed", async () => {
    mocks.env = { APP_URL: "https://desk.example", NEXTAUTH_URL: "", EMAIL_SMTP_URL: "smtp://mail" };
    mocks.emailSend.mockResolvedValue({ ok: true });

    const res = await POST(resetRequest());
    const json = await res.json();

    expect(json.emailed).toBe(true);
    expect(json.resetUrl).toBeNull();
    expect(json.resetToken).toBeUndefined();
    expect(mocks.emailSend.mock.calls[0]![0].bodyText).toContain(
      "https://desk.example/reset-password?token=",
    );
  });

  it("returns the link when the email failed to send", async () => {
    mocks.env = { APP_URL: "https://desk.example", NEXTAUTH_URL: "", EMAIL_SMTP_URL: "smtp://mail" };
    mocks.emailSend.mockResolvedValue({ ok: false, error: "SMTP down" });

    const json = await (await POST(resetRequest())).json();

    expect(json.emailed).toBe(false);
    expect(json.resetUrl).toMatch(/^https:\/\/desk\.example\/reset-password\?token=/);
  });
});

describe("admin users list reports when sessions were ended, not a fake session count", () => {
  it("returns sessionsEndedAt from the revocation marker", async () => {
    const endedAt = new Date("2026-11-15T09:00:00.000Z");
    mocks.userFindMany.mockResolvedValue([
      {
        id: "u_1",
        email: "u@x.test",
        name: "U",
        isActive: true,
        isSuspended: false,
        isPlatformAdmin: false,
        emailVerified: null,
        lastLoginAt: null,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        lockedUntil: null,
        memberships: [],
        sessions: [{ expires: endedAt }],
      },
    ]);

    const json = await (await GET(new NextRequest("http://localhost/api/admin/users"))).json();

    expect(json.users[0].sessionsEndedAt).toBe(endedAt.toISOString());
    expect(json.users[0]).not.toHaveProperty("activeSessions");
    expect(mocks.userFindMany.mock.calls[0]![0].include.sessions.where).toEqual({
      sessionToken: { startsWith: "revoked:" },
    });
  });
});
