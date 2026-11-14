/**
 * PATCH /api/agent: new workspaces (bookingUrl null) can save, validation errors are 400s with a
 * readable message, and provider/model stay platform-managed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
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
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

import { PATCH } from "@/app/api/agent/route";

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// What the AI Agent page sends for a brand-new workspace.
const newWorkspaceBody = {
  brandTone: "professional, helpful, concise",
  formality: "professional",
  responseLength: "medium",
  emojiUsage: "minimal",
  confidenceThreshold: 0.65,
  bookingUrl: null,
  maxFollowUps: 3,
  qualificationQuestions: [],
  restrictedTopics: [],
};

describe("PATCH /api/agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "cfg_1", organisationId: "org_a" });
    mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cfg_1",
      aiProvider: "anthropic",
      model: "x",
      ...data,
    }));
  });

  it("saves a new workspace whose bookingUrl is null", async () => {
    const res = await patch(newWorkspaceBody);
    expect(res.status).toBe(200);
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "cfg_1" },
      data: { bookingUrl: null },
    });
    const json = await res.json();
    expect(json.config).not.toHaveProperty("aiProvider");
    expect(json.config).not.toHaveProperty("model");
  });

  it("returns 400 with a readable message for invalid input (not a 500 with raw zod text)", async () => {
    const res = await patch({ ...newWorkspaceBody, confidenceThreshold: 5 });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/^Invalid confidenceThreshold: /);
    expect(error).not.toMatch(/"code"|\[\s*\{/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("ignores provider/model routing from workspace users", async () => {
    const res = await patch({ ...newWorkspaceBody, aiProvider: "openai", model: "gpt-x" });
    expect(res.status).toBe(200);
    const data = mocks.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("aiProvider");
    expect(data).not.toHaveProperty("model");
  });
});
