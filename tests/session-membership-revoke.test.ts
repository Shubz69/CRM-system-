import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberRole } from "@prisma/client";
import { WorkspaceAccessError } from "@/services/workspace-access";

const getServerSession = vi.fn();
const assertActiveWorkspaceAccess = vi.fn();

vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/services/workspace-access", async () => {
  const actual = await vi.importActual<typeof import("@/services/workspace-access")>(
    "@/services/workspace-access",
  );
  return {
    ...actual,
    assertActiveWorkspaceAccess: (...args: unknown[]) => assertActiveWorkspaceAccess(...args),
  };
});

describe("requireSession membership gate after Team Remove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({
      user: {
        id: "user_1",
        organisationId: "org_qa",
        role: MemberRole.READ_ONLY,
        email: "victim@example.com",
        name: "Victim",
        mustChangePassword: false,
        isPlatformAdmin: false,
      },
    });
  });

  it("allows session when live membership exists", async () => {
    assertActiveWorkspaceAccess.mockResolvedValue(undefined);
    const { requireSession } = await import("@/lib/session");
    const session = await requireSession();
    expect(session.organisationId).toBe("org_qa");
    expect(assertActiveWorkspaceAccess).toHaveBeenCalledWith({
      userId: "user_1",
      organisationId: "org_qa",
    });
  });

  it("rejects JWT that still claims a revoked org (immediate access loss)", async () => {
    assertActiveWorkspaceAccess.mockRejectedValue(
      new WorkspaceAccessError(
        "SESSION_ORG_INVALID",
        "Your session points to a workspace you can no longer access. Please sign in again.",
      ),
    );
    const { requireSession } = await import("@/lib/session");
    await expect(requireSession()).rejects.toThrow("UNAUTHORIZED");
  });
});
