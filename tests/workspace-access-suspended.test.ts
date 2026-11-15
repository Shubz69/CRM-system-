import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRole } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  organisationFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: { findFirst: mocks.organisationFindFirst },
    organisationMember: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
    },
  },
}));
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mocks.getServerSession(...args),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

import {
  assertActiveWorkspaceAccess,
  hasUsableWorkspace,
  WORKSPACE_SUSPENDED_MESSAGE,
  WorkspaceAccessError,
} from "@/services/workspace-access";

function member(overrides: { isPlatformAdmin?: boolean } = {}) {
  return {
    id: "m_1",
    role: MemberRole.SALES_AGENT,
    user: { isActive: true, isSuspended: false, deletedAt: null, isPlatformAdmin: false, ...overrides },
  };
}

describe("assertActiveWorkspaceAccess — suspended workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue(member());
  });

  it("allows members of an active workspace", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "ACTIVE" });
    await expect(
      assertActiveWorkspaceAccess({ userId: "u_1", organisationId: "org_1" }),
    ).resolves.toEqual({ role: MemberRole.SALES_AGENT });
  });

  it("refuses members of a suspended workspace on their very next request", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "SUSPENDED" });
    const attempt = assertActiveWorkspaceAccess({ userId: "u_1", organisationId: "org_1" });
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(attempt).rejects.toMatchObject({
      code: "SESSION_ORG_INVALID",
      message: WORKSPACE_SUSPENDED_MESSAGE,
    });
  });

  it("lets platform admins into a suspended workspace so they can manage it", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "SUSPENDED" });
    mocks.memberFindUnique.mockResolvedValue(member({ isPlatformAdmin: true }));
    await expect(
      assertActiveWorkspaceAccess({ userId: "admin_1", organisationId: "org_1" }),
    ).resolves.toEqual({ role: MemberRole.SALES_AGENT });
  });

  it("requireSession answers UNAUTHORIZED for a suspended workspace", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "SUSPENDED" });
    mocks.getServerSession.mockResolvedValue({
      user: { id: "u_1", organisationId: "org_1", role: MemberRole.OWNER, email: "o@x.test" },
    });
    const { requireSession } = await import("@/lib/session");
    await expect(requireSession()).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("hasUsableWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberFindUnique.mockResolvedValue(member());
  });

  it("is false without a workspace in the session", async () => {
    await expect(hasUsableWorkspace({ userId: "u_1", organisationId: undefined })).resolves.toBe(false);
    expect(mocks.organisationFindFirst).not.toHaveBeenCalled();
  });

  it("is false when the user was removed from the workspace", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "ACTIVE" });
    mocks.memberFindUnique.mockResolvedValue(null);
    mocks.memberFindFirst.mockResolvedValue(null);
    await expect(hasUsableWorkspace({ userId: "u_1", organisationId: "org_1" })).resolves.toBe(false);
  });

  it("is false when the workspace is suspended", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "SUSPENDED" });
    await expect(hasUsableWorkspace({ userId: "u_1", organisationId: "org_1" })).resolves.toBe(false);
  });

  it("is true for a live membership", async () => {
    mocks.organisationFindFirst.mockResolvedValue({ id: "org_1", status: "ACTIVE" });
    await expect(hasUsableWorkspace({ userId: "u_1", organisationId: "org_1" })).resolves.toBe(true);
  });

  it("does not lock people out on a database error", async () => {
    mocks.organisationFindFirst.mockRejectedValue(new Error("Can't reach database server"));
    await expect(hasUsableWorkspace({ userId: "u_1", organisationId: "org_1" })).resolves.toBe(true);
  });
});
