/**
 * Routes pass the internal "Forbidden: missing permission x:y" error straight into jsonError;
 * people must see a sentence they can act on instead (a sales agent saving a channel used to
 * get "Forbidden: missing permission integrations:manage" in a toast).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { readablePermissionError } from "@/lib/permissions";
import { jsonError } from "@/lib/session";

describe("readablePermissionError", () => {
  it("names what the missing permission would allow", () => {
    expect(readablePermissionError("Forbidden: missing permission integrations:manage")).toBe(
      "You don't have permission to manage integrations and messaging channels. Ask a workspace owner or admin if you need it.",
    );
    expect(readablePermissionError("Forbidden: missing permission platform:manage")).toMatch(
      /^You don't have permission to use the platform admin tools\./,
    );
  });

  it("falls back to a general sentence for an unknown or missing permission", () => {
    expect(readablePermissionError("Forbidden: missing permission")).toBe(
      "You don't have permission to do that. Ask a workspace owner or admin if you need it.",
    );
    expect(readablePermissionError("Forbidden: missing permission made:up")).toMatch(
      /^You don't have permission to do that\./,
    );
  });

  it("leaves every other message alone", () => {
    expect(readablePermissionError("Only workspace owners can do that.")).toBe(
      "Only workspace owners can do that.",
    );
  });
});

describe("jsonError", () => {
  it("rewrites raw permission errors on 403 responses", async () => {
    const res = jsonError("Forbidden: missing permission agent:manage", 403);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "You don't have permission to manage the AI agent. Ask a workspace owner or admin if you need it.",
    });
  });

  it("passes other statuses through untouched", async () => {
    const res = jsonError("Choose a timezone.", 400);
    expect(await res.json()).toEqual({ error: "Choose a timezone." });
  });
});

describe("jsonError status for permission failures", () => {
  it("turns a catch-all 500 for a missing permission into a readable 403", async () => {
    const res = jsonError("Forbidden: missing permission automations:manage", 500);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "You don't have permission to manage automations and approvals. Ask a workspace owner or admin if you need it.",
    );
  });

  it("does the same for a catch-all 400", async () => {
    expect(jsonError("Forbidden: missing permission leads:write", 400).status).toBe(403);
  });

  it("leaves other errors' status alone", () => {
    expect(jsonError("Couldn't save. Try again.", 500).status).toBe(500);
    expect(jsonError("Unauthorized", 401).status).toBe(401);
  });
});
