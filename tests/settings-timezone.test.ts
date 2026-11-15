/**
 * PATCH /api/settings: workspace owners/admins can change the timezone to a valid IANA zone;
 * other roles get 403 and invalid zones a readable 400.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSessionForMutation: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: vi.fn(),
  requireSessionForMutation: (...args: unknown[]) => mocks.requireSessionForMutation(...args),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  WorkspaceChangedError: class WorkspaceChangedError extends Error {},
  workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
}));
vi.mock("@/services/audit", () => ({
  tenantAuditLogWhere: vi.fn(),
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: {
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      update: (...args: unknown[]) => mocks.update(...args),
    },
  },
}));

import { PATCH } from "@/app/api/settings/route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/settings timezone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSessionForMutation.mockResolvedValue({ organisationId: "org_a", userId: "u1", role: "OWNER" });
    mocks.findUnique.mockResolvedValue({ timezone: "UTC" });
    mocks.update.mockImplementation(async ({ data }: { data: { timezone: string } }) => data);
  });

  it("owner sets a valid IANA timezone (canonical casing) and it is audited", async () => {
    const res = await patch({ timezone: "europe/london" });
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "org_a" },
      data: { timezone: "Europe/London" },
      select: { timezone: true },
    });
    expect((await res.json()).organisation.timezone).toBe("Europe/London");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.timezone_updated", metadata: { from: "UTC", to: "Europe/London" } }),
    );
  });

  it("administrators may change it too", async () => {
    mocks.requireSessionForMutation.mockResolvedValue({ organisationId: "org_a", userId: "u2", role: "ADMINISTRATOR" });
    expect((await patch({ timezone: "America/New_York" })).status).toBe(200);
  });

  it.each(["MANAGER", "SALES_AGENT", "ANALYST", "READ_ONLY"])("%s gets 403", async (role) => {
    mocks.requireSessionForMutation.mockResolvedValue({ organisationId: "org_a", userId: "u3", role });
    const res = await patch({ timezone: "Europe/London" });
    expect(res.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["Mars/Olympus_Mons", "+05:00", "", "Europe/London; DROP"])("rejects %j with a readable 400", async (timezone) => {
    const res = await patch({ timezone });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recognised timezone/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("a missing timezone asks the user to choose one", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Choose a timezone.");
  });
});
