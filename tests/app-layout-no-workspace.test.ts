import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  hasUsableWorkspace: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mocks.getServerSession(...args),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => mocks.redirect(path) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-pathname": "/home" }) }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/services/workspace-access", () => ({
  hasUsableWorkspace: (...args: unknown[]) => mocks.hasUsableWorkspace(...args),
}));

import AppLayout from "@/app/(app)/layout";

function session(user: Record<string, unknown>) {
  return { user: { id: "u_1", email: "u@x.test", name: "U", ...user } };
}

describe("(app) layout with no usable workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a removed member to the no-workspace page instead of an empty desk", async () => {
    mocks.getServerSession.mockResolvedValue(session({ organisationId: undefined }));
    mocks.hasUsableWorkspace.mockResolvedValue(false);

    await expect(AppLayout({ children: null })).rejects.toThrow("REDIRECT:/no-workspace");
    expect(mocks.hasUsableWorkspace).toHaveBeenCalledWith({ userId: "u_1", organisationId: undefined });
  });

  it("sends a member of a suspended workspace to the no-workspace page", async () => {
    mocks.getServerSession.mockResolvedValue(session({ organisationId: "org_suspended" }));
    mocks.hasUsableWorkspace.mockResolvedValue(false);

    await expect(AppLayout({ children: null })).rejects.toThrow("REDIRECT:/no-workspace");
  });

  it("renders the app shell when the workspace is usable", async () => {
    mocks.getServerSession.mockResolvedValue(session({ organisationId: "org_1" }));
    mocks.hasUsableWorkspace.mockResolvedValue(true);

    const element = await AppLayout({ children: null });

    expect(element).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("keeps platform admins without a workspace in the app (admin console)", async () => {
    mocks.getServerSession.mockResolvedValue(
      session({ organisationId: undefined, isPlatformAdmin: true }),
    );

    const element = await AppLayout({ children: null });

    expect(element).toBeTruthy();
    expect(mocks.hasUsableWorkspace).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still sends a revoked token to sign-in", async () => {
    mocks.getServerSession.mockResolvedValue({ user: { id: "" } });

    await expect(AppLayout({ children: null })).rejects.toThrow("REDIRECT:/login");
  });
});
