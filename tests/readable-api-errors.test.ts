/**
 * Simulator and messaging-channel routes return readable messages — never raw zod issue JSON
 * or Prisma text (which can include server file paths).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  processInboundMessage: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  requirePermissionForMutation: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  WorkspaceChangedError: class WorkspaceChangedError extends Error {},
  workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
}));
vi.mock("@/services/inbound-pipeline", () => ({
  processInboundMessage: (...args: unknown[]) => mocks.processInboundMessage(...args),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    messagingChannel: {
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      upsert: (...args: unknown[]) => mocks.upsert(...args),
    },
  },
}));

import { POST as simulate } from "@/app/api/simulator/route";
import { POST as saveChannel } from "@/app/api/messaging-channels/route";

const RAW_LEAK = /"code"|"path"|\[\s*\{|invalid_type|prisma|invocation|\.ts\b/i;

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("readable API errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("simulator: empty or missing message gives a plain sentence", async () => {
    for (const body of [{ text: "" }, { text: "   " }, {}]) {
      const res = await simulate(req("http://localhost/api/simulator", body));
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error).toBe("Type a message to simulate.");
    }
    const badEmail = await simulate(req("http://localhost/api/simulator", { text: "hi", email: "nope" }));
    expect((await badEmail.json()).error).toMatch(/valid email/);
    const badJson = await simulate(req("http://localhost/api/simulator", "{not json"));
    expect(badJson.status).toBe(400);
    expect(mocks.processInboundMessage).not.toHaveBeenCalled();
  });

  it("messaging channels: validation errors are readable", async () => {
    const res = await saveChannel(req("http://localhost/api/messaging-channels", { displayName: "IG" }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe("Channel ID is required.");
    expect(error).not.toMatch(RAW_LEAK);
    const wrongProvider = await saveChannel(
      req("http://localhost/api/messaging-channels", { provider: "meta_instagram", externalId: "1", displayName: "x" }),
    );
    expect((await wrongProvider.json()).error).toBe("Only ManyChat channels can be added here.");
  });

  it("messaging channels: database errors never leak", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockRejectedValue(
      new Error("Invalid `prisma.messagingChannel.upsert()` invocation in C:\\repo\\src\\app\\api\\messaging-channels\\route.ts:107:5"),
    );
    const res = await saveChannel(
      req("http://localhost/api/messaging-channels", { externalId: "123", displayName: "Salon IG" }),
    );
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe("Couldn't save the messaging channel. Try again.");
  });
});
