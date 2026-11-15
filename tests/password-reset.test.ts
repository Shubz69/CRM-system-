import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";

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
  rateLimit: vi.fn(),
  loggerError: vi.fn(),
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
  rateLimit: (...args: unknown[]) => mocks.rateLimit(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: (...args: unknown[]) => mocks.loggerError(...args), warn: vi.fn() },
}));

import { POST } from "@/app/api/auth/password-reset/route";

function request(body: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest("https://crm.example/api/auth/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const GENERIC_OK = {
  ok: true,
  message: "If the account exists, a reset link was sent by email.",
};

const PROD_SMTP_ENV = {
  NODE_ENV: "production",
  EMAIL_SMTP_URL: "smtp://user:pass@smtp.example:587",
  EMAIL_FROM: "noreply@example.com",
  APP_URL: "https://crm.example",
  NEXTAUTH_URL: "https://crm.example",
};

describe("POST /api/auth/password-reset — request link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenDeleteMany.mockResolvedValue({ count: 0 });
    mocks.tokenCreate.mockResolvedValue({});
    mocks.writeAuditLog.mockResolvedValue(undefined);
    mocks.emailSend.mockResolvedValue({ ok: true, provider: "smtp", messageId: "m1" });
    mocks.rateLimit.mockReturnValue(true);
    delete process.env.ADMIN_BOOTSTRAP_SECRET;
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
    expect(json).toEqual(GENERIC_OK);
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

  it("answers a failed send for an existing account exactly like an unknown email (logged server-side)", async () => {
    mocks.getEnv.mockReturnValue(PROD_SMTP_ENV);
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

    const existing = await POST(request({ email: "admin@example.com" }));
    const existingJson = await existing.json();

    expect(mocks.emailSend).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Password reset email failed",
      expect.objectContaining({ userId: "u1", error: expect.stringMatching(/EMAIL_FROM/) }),
    );

    mocks.userFindFirst.mockResolvedValue(null);
    const unknown = await POST(request({ email: "nobody@example.com" }));

    expect(existing.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(existingJson).toEqual(GENERIC_OK);
    expect(await unknown.json()).toEqual(existingJson);
  });

  it("treats a thrown send like a failed one — generic ok, no 500", async () => {
    mocks.getEnv.mockReturnValue(PROD_SMTP_ENV);
    mocks.userFindFirst.mockResolvedValue({ id: "u1", email: "admin@example.com", isActive: true });
    mocks.emailSend.mockRejectedValue(new Error("ECONNREFUSED smtp.example:587"));

    const res = await POST(request({ email: "admin@example.com" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GENERIC_OK);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Password reset email failed",
      expect.objectContaining({ error: expect.stringMatching(/ECONNREFUSED/) }),
    );
  });

  it("returns the same 503 for every email when APP_URL is missing (checked before the lookup)", async () => {
    mocks.getEnv.mockReturnValue({ ...PROD_SMTP_ENV, APP_URL: undefined, NEXTAUTH_URL: undefined });
    mocks.userFindFirst.mockResolvedValue({ id: "u1", email: "admin@example.com", isActive: true });

    const res = await POST(request({ email: "admin@example.com" }));

    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).toMatch(/APP_URL/);
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
  });

  it("rate-limits on the first X-Forwarded-For address, not the raw header", async () => {
    mocks.getEnv.mockReturnValue(PROD_SMTP_ENV);
    mocks.userFindFirst.mockResolvedValue(null);

    await POST(request({ email: "a@example.com" }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));

    expect(mocks.rateLimit).toHaveBeenCalledWith("password-reset:203.0.113.7", 10, 60_000);
  });

  it("limits reset requests per email (case-insensitive), 5 per hour", async () => {
    mocks.getEnv.mockReturnValue(PROD_SMTP_ENV);
    mocks.userFindFirst.mockResolvedValue(null);

    await POST(request({ email: "Admin@Example.com" }));
    await POST(request({ email: "admin@example.com" }));

    const emailCalls = mocks.rateLimit.mock.calls.filter(([key]) =>
      String(key).startsWith("password-reset:email:"),
    );
    expect(emailCalls).toHaveLength(2);
    expect(emailCalls[0]![0]).toBe(emailCalls[1]![0]);
    expect(String(emailCalls[0]![0])).not.toContain("admin@example.com");
    expect(emailCalls[0]!.slice(1)).toEqual([5, 60 * 60_000]);

    mocks.rateLimit.mockImplementation((key: string) => !key.startsWith("password-reset:email:"));
    mocks.userFindFirst.mockClear();
    const limited = await POST(request({ email: "admin@example.com" }));
    expect(limited.status).toBe(429);
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.emailSend).not.toHaveBeenCalled();
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

  it("still tells a bootstrap operator when no account matches", async () => {
    process.env.ADMIN_BOOTSTRAP_SECRET = "bootstrap-secret-16chars";
    mocks.getEnv.mockReturnValue({ ...PROD_SMTP_ENV, EMAIL_SMTP_URL: undefined });
    mocks.userFindFirst.mockResolvedValue(null);

    const res = await POST(
      request({ email: "nobody@example.com" }, { "x-admin-bootstrap-secret": "bootstrap-secret-16chars" }),
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /api/auth/password-reset — complete reset", () => {
  const token = "a".repeat(64);
  const tokenHash = createHash("sha256").update(token).digest("hex");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockReturnValue(true);
    mocks.tokenFindFirst.mockResolvedValue(null);
  });

  it("limits attempts per reset token, 5 per hour", async () => {
    const res = await POST(request({ token, password: "a-new-password-123" }));

    expect(res.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledWith(`password-reset:token:${tokenHash}`, 5, 60 * 60_000);
  });

  it("returns 429 without touching the database once the token limit is hit", async () => {
    mocks.rateLimit.mockImplementation((key: string) => !key.startsWith("password-reset:token:"));

    const res = await POST(request({ token, password: "a-new-password-123" }));

    expect(res.status).toBe(429);
    expect(mocks.tokenFindFirst).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
