/**
 * /api/agent: booking URL must be an http(s) URL (empty clears it), qualification questions are
 * stored one per line, and roles without agent:manage get 403 (not 500).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentConfiguration: {
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      update: (...args: unknown[]) => mocks.update(...args),
    },
  },
}));

vi.mock("@/lib/session", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

import { GET, PATCH } from "@/app/api/agent/route";

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/agent validation and permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ organisationId: "org_a", userId: "u1" });
    mocks.findFirst.mockResolvedValue({ id: "cfg_1", organisationId: "org_a" });
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cfg_1",
      ...data,
    }));
  });

  it.each(["not a url", "calendly.com/me", "javascript:alert(1)", "ftp://files.example.com/x"])(
    "rejects booking URL %j with a readable 400",
    async (bookingUrl) => {
      const res = await patch({ bookingUrl });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error).toMatch(/Booking URL must be a full web address/);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it("accepts https booking URLs and clears an empty one to null", async () => {
    expect((await patch({ bookingUrl: " https://cal.com/salon/intro " })).status).toBe(200);
    expect(mocks.update.mock.calls[0]![0].data.bookingUrl).toBe("https://cal.com/salon/intro");
    expect((await patch({ bookingUrl: "" })).status).toBe(200);
    expect(mocks.update.mock.calls[1]![0].data.bookingUrl).toBeNull();
    expect((await patch({ bookingUrl: null })).status).toBe(200);
    expect(mocks.update.mock.calls[2]![0].data.bookingUrl).toBeNull();
  });

  it("stores one qualification question per line (splits embedded newlines, drops blanks)", async () => {
    const res = await patch({ qualificationQuestions: ["What's your budget?\nWhen do you start?", "  ", "Who decides?"] });
    expect(res.status).toBe(200);
    expect(mocks.update.mock.calls[0]![0].data.qualificationQuestions).toEqual([
      "What's your budget?",
      "When do you start?",
      "Who decides?",
    ]);
  });

  it("returns 403 (not 500) when the role lacks agent:manage", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("Forbidden: missing permission agent:manage"));
    const patchRes = await patch({ brandTone: "x" });
    expect(patchRes.status).toBe(403);
    const getRes = await GET();
    expect(getRes.status).toBe(403);
    expect((await getRes.json()).error).not.toMatch(/agent:manage/);
  });

  it("never returns raw database errors", async () => {
    mocks.update.mockRejectedValue(
      new Error("Invalid `prisma.agentConfiguration.update()` invocation in C:\\app\\src\\route.ts"),
    );
    const res = await patch({ brandTone: "x" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/prisma|invocation|route\.ts/i);
  });
});
