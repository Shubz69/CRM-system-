import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  tokenDeleteMany: vi.fn(),
  tokenCreate: vi.fn(),
  tokenFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  writeAuditLog: vi.fn(),
  getEnv: vi.fn(),
  emailSend: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: mocks.userFindFirst,
      update: mocks.userUpdate,
    },
    verificationToken: {
      deleteMany: mocks.tokenDeleteMany,
      create: mocks.tokenCreate,
      findFirst: mocks.tokenFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mocks.getEnv(),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

vi.mock("@/adapters/email", () => ({
  getEmailAdapter: () => ({
    name: "smtp",
    send: mocks.emailSend,
  }),
}));

vi.mock("@/lib/session", () => ({
  jsonError: (message: string, status: number) =>
    Response.json({ error: message }, { status }),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => true,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { POST } from "@/app/api/auth/password-reset/route";

function request(body: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest("https://crm.example/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password-reset — request link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenDeleteMany.mockResolvedValue({ count: 0 });
    mocks.tokenCreate.mockResolvedValue({});
    mocks.writeAuditLog.mockResolvedValue(undefined);
    mocks.emailSend.mockResolvedValue({ ok: true, provider: "smtp", messageId: "m1" });
  });

  it("returns 503 in production when SMTP is not configured (no silent success)", async () => {
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "production",
      EMAIL_SMTP_URL: undefined,
      EMAIL_FROM: undefined,
      APP_URL: "https://crm.example",
      NEXTAUTH_URL: "https://crm.example",
    });

    const res = await POST(request({ email: "admin@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(String(json.error)).toMatch(/EMAIL_SMTP_URL/);
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.emailSend).not.toHaveBeenCalled();
  });

  it("emails a reset link when SMTP is configured (includes platform-admin users)", async () => {
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "production",
      EMAIL_SMTP_URL: "smtp://user:pass@smtp.example:587",
      EMAIL_FROM: "noreply@example.com",
      APP_URL: "https://crm.example",
      NEXTAUTH_URL: "https://crm.example",
    });
    mocks.userFindFirst.mockResolvedValue({
      id: "u1",
      email: "admin@example.com",
      isPlatformAdmin: true,
      isActive: true,
    });

    const res = await POST(request({ email: "admin@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.emailed).toBe(true);
    expect(json.resetUrl).toBeUndefined();
    expect(mocks.emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["admin@example.com"],
        subject: expect.stringMatching(/reset/i),
      }),
    );
    const bodyText = String(mocks.emailSend.mock.calls[0]?.[0]?.bodyText || "");
    expect(bodyText).toContain("https://crm.example/reset-password?token=");
  });

  it("returns 503 when SMTP send fails in production", async () => {
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "production",
      EMAIL_SMTP_URL: "smtp://user:pass@smtp.example:587",
      EMAIL_FROM: "noreply@example.com",
      APP_URL: "https://crm.example",
      NEXTAUTH_URL: "https://crm.example",
    });
    mocks.userFindFirst.mockResolvedValue({
      id: "u1",
      email: "admin@example.com",
      isActive: true,
    });
    mocks.emailSend.mockResolvedValue({
      ok: false,
      provider: "smtp",
      error: "EMAIL_FROM must be set to a real production address before sending mail",
    });

    const res = await POST(request({ email: "admin@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(String(json.error)).toMatch(/Could not send the reset email/);
  });

  it("returns an inline recovery link when ADMIN_BOOTSTRAP_SECRET is provided", async () => {
    process.env.ADMIN_BOOTSTRAP_SECRET = "bootstrap-secret-16chars";
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "production",
      EMAIL_SMTP_URL: undefined,
      APP_URL: "https://crm.example",
      NEXTAUTH_URL: "https://crm.example",
    });
    mocks.userFindFirst.mockResolvedValue({
      id: "u1",
      email: "admin@example.com",
      isActive: true,
    });

    const res = await POST(
      request(
        { email: "admin@example.com" },
        { "x-admin-bootstrap-secret": "bootstrap-secret-16chars" },
      ),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.resetUrl).toMatch(/^https:\/\/crm\.example\/reset-password\?token=/);
    expect(json.emailed).toBe(false);
  });
});
