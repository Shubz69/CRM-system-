import { describe, expect, it } from "vitest";
import { pickActiveWorkspace } from "@/services/active-workspace";
import type { MemberRole } from "@prisma/client";

function membership(input: {
  organisationId: string;
  role?: MemberRole;
  isPlatform?: boolean;
  deletedAt?: Date | null;
  status?: string;
  name?: string;
}) {
  return {
    organisationId: input.organisationId,
    role: input.role ?? ("OWNER" as MemberRole),
    organisation: {
      id: input.organisationId,
      name: input.name ?? input.organisationId,
      isPlatform: input.isPlatform ?? false,
      deletedAt: input.deletedAt ?? null,
      status: input.status ?? "ACTIVE",
    },
  };
}

describe("pickActiveWorkspace", () => {
  it("prefers an explicit preferredOrganisationId when membership is valid", () => {
    const rows = [
      membership({ organisationId: "demo", role: "SUPER_ADMIN" as MemberRole }),
      membership({
        organisationId: "platform",
        role: "SUPER_ADMIN" as MemberRole,
        isPlatform: true,
      }),
    ];
    const picked = pickActiveWorkspace(rows, "platform");
    expect(picked?.organisationId).toBe("platform");
  });

  it("defaults to the first non-platform tenant when both are SUPER_ADMIN", () => {
    const rows = [
      membership({
        organisationId: "platform",
        role: "SUPER_ADMIN" as MemberRole,
        isPlatform: true,
        name: "Agent Desk Platform",
      }),
      membership({
        organisationId: "demo",
        role: "SUPER_ADMIN" as MemberRole,
        name: "Demo Agency",
      }),
    ];
    // Old bug: find(SUPER_ADMIN) would pick platform first.
    const picked = pickActiveWorkspace(rows, null);
    expect(picked?.organisationId).toBe("demo");
  });

  it("ignores deleted or non-active organisations", () => {
    const rows = [
      membership({
        organisationId: "gone",
        deletedAt: new Date(),
        role: "OWNER" as MemberRole,
      }),
      membership({ organisationId: "alive", role: "OWNER" as MemberRole }),
    ];
    expect(pickActiveWorkspace(rows, "gone")?.organisationId).toBe("alive");
  });

  it("falls back to platform org only when that is all the user has", () => {
    const rows = [
      membership({
        organisationId: "platform",
        isPlatform: true,
        role: "SUPER_ADMIN" as MemberRole,
      }),
    ];
    expect(pickActiveWorkspace(rows, null)?.organisationId).toBe("platform");
  });
});
