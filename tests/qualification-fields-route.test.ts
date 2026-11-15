/**
 * /api/qualification-fields: deactivated fields can be reactivated, reusing a key gives a
 * friendly 409, and Prisma/zod text never reaches the client.
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    qualificationField: {
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      updateMany: (...args: unknown[]) => mocks.updateMany(...args),
    },
  },
}));

vi.mock("@/lib/session", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

import { GET, PATCH, POST } from "@/app/api/qualification-fields/route";

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/qualification-fields", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RAW_LEAK = /prisma|invocation|P2002|Unique constraint|\.ts|\\|"code"/i;

describe("/api/qualification-fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ organisationId: "org_a", userId: "u1" });
  });

  it("reactivates a deactivated field via PATCH { active: true }", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ id: "f1", key: "budget", active: false })
      .mockResolvedValueOnce({ id: "f1", key: "budget", active: true });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const res = await PATCH(request("PATCH", { id: "f1", active: true }));
    expect(res.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "f1", organisationId: "org_a" },
      data: { active: true },
    });
    expect((await res.json()).field.active).toBe(true);
  });

  it("returns a friendly 409 when the key belongs to a deactivated field", async () => {
    mocks.findFirst.mockResolvedValue({ id: "f1", active: false });
    const res = await POST(request("POST", { key: "budget", label: "Budget" }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("DUPLICATE_KEY");
    expect(json.existingFieldId).toBe("f1");
    expect(json.error).toMatch(/deactivated field already uses the key "budget".*Reactivate/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps a concurrent unique-constraint violation to the same 409 (no raw Prisma text)", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "Invalid `prisma.qualificationField.create()` invocation in C:\\repo\\src\\app\\api\\qualification-fields\\route.ts:33:1\nUnique constraint failed on the fields: (`organisationId`,`key`)",
        { code: "P2002", clientVersion: "6.19.3" },
      ),
    );
    const res = await POST(request("POST", { key: "budget", label: "Budget" }));
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toMatch(/already exists/);
    expect(error).not.toMatch(RAW_LEAK);
  });

  it("never returns raw Prisma text for unexpected errors", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockRejectedValue(new Error("Invalid `prisma.qualificationField.create()` invocation in C:\\x.ts"));
    const res = await POST(request("POST", { key: "budget", label: "Budget" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(RAW_LEAK);
  });

  it("returns readable validation messages, not zod JSON", async () => {
    const res = await POST(request("POST", { key: "", label: "Budget" }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toBe("Key is required.");
    const missing = await POST(request("POST", { label: "Budget" }));
    expect((await missing.json()).error).toBe("Key is required.");
    const badWeight = await POST(request("POST", { key: "k", label: "L", weight: 500 }));
    const weightError = (await badWeight.json()).error as string;
    expect(weightError).toMatch(/^Weight/);
    expect(weightError).not.toMatch(RAW_LEAK);
  });

  it("returns 403 for roles without agent:manage", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("Forbidden: missing permission agent:manage"));
    expect((await GET()).status).toBe(403);
    expect((await POST(request("POST", { key: "k", label: "L" }))).status).toBe(403);
  });
});
