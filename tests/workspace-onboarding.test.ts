import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationStatus, MemberRole } from "@prisma/client";

vi.mock("@/lib/db", () => {
  const organisation = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const user = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const organisationMember = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  };
  const organisationInvitation = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const organisationPreference = {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({
      id: "pref_1",
      ...args.create,
    })),
  };
  return {
    prisma: {
      organisation,
      user,
      organisationMember,
      organisationInvitation,
      organisationPreference,
      $transaction: vi.fn(async (ops: unknown) => {
        if (typeof ops === "function") {
          return ops({
            organisation,
            user,
            organisationMember,
            organisationInvitation,
            organisationPreference,
          });
        }
        if (Array.isArray(ops)) {
          return Promise.all(ops);
        }
        return ops;
      }),
      __mocks: {
        organisation,
        user,
        organisationMember,
        organisationInvitation,
        organisationPreference,
      },
    },
  };
});

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/adapters/email", () => ({
  getEmailAdapter: vi.fn(() => ({
    name: "email-mock",
    send: vi.fn(async () => ({ ok: true, provider: "email-mock", messageId: "m1" })),
  })),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({
    APP_URL: "http://localhost:3000",
    NEXTAUTH_URL: "http://localhost:3000",
    EMAIL_SMTP_URL: undefined as string | undefined,
    NODE_ENV: "test",
  })),
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn(async (pw: string) => `hashed:${pw}`),
}));

import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import { getEnv } from "@/lib/env";
import { getEmailAdapter } from "@/adapters/email";
import {
  acceptInvite,
  changeMemberRole,
  createWorkspaceWithOwner,
  inviteMember,
  OnboardingError,
  removeMember,
  resendInvite,
  revokeInvite,
} from "@/services/workspace-onboarding";

type Mocks = {
  organisation: Record<string, ReturnType<typeof vi.fn>>;
  user: Record<string, ReturnType<typeof vi.fn>>;
  organisationMember: Record<string, ReturnType<typeof vi.fn>>;
  organisationInvitation: Record<string, ReturnType<typeof vi.fn>>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describe("workspace onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      APP_URL: "http://localhost:3000",
      NEXTAUTH_URL: "http://localhost:3000",
      EMAIL_SMTP_URL: undefined,
      NODE_ENV: "test",
    });
  });

  it("createWorkspaceWithOwner creates org + OWNER membership and sets activeOrganisationId", async () => {
    mocks.organisation.findUnique.mockResolvedValue(null);
    mocks.user.findFirst.mockResolvedValue(null);
    mocks.user.create.mockResolvedValue({
      id: "user_1",
      email: "owner@acme.test",
      name: "Owner",
      passwordHash: "hashed:password12345",
      isActive: true,
    });
    mocks.organisation.create.mockResolvedValue({
      id: "org_1",
      name: "Acme",
      slug: "acme",
    });
    mocks.user.update.mockResolvedValue({});

    const result = await createWorkspaceWithOwner({
      name: "Acme",
      slug: "acme",
      ownerEmail: "Owner@Acme.test",
      ownerName: "Owner",
      password: "password12345",
    });

    expect(result.organisation.id).toBe("org_1");
    expect(result.role).toBe(MemberRole.OWNER);
    expect(mocks.organisation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: "acme",
          members: {
            create: {
              userId: "user_1",
              role: MemberRole.OWNER,
            },
          },
        }),
      }),
    );
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { activeOrganisationId: "org_1" },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.onboarding.create",
        organisationId: "org_1",
      }),
    );
  });

  it("createWorkspaceWithOwner allows existing user with memberships to own a new org", async () => {
    mocks.organisation.findUnique.mockResolvedValue(null);
    mocks.user.findFirst.mockResolvedValue({
      id: "user_existing",
      email: "multi@acme.test",
      name: "Multi",
      passwordHash: "hashed:x",
      isActive: true,
    });
    mocks.organisation.create.mockResolvedValue({
      id: "org_new",
      name: "Second",
      slug: "second",
    });
    mocks.user.update.mockResolvedValue({});

    const result = await createWorkspaceWithOwner({
      name: "Second",
      slug: "second",
      ownerEmail: "multi@acme.test",
      existingUserId: "user_existing",
    });

    expect(result.user.id).toBe("user_existing");
    expect(mocks.user.create).not.toHaveBeenCalled();
    expect(result.role).toBe(MemberRole.OWNER);
  });

  it("inviteMember rejects OWNER and SUPER_ADMIN invite roles", async () => {
    await expect(
      inviteMember({
        organisationId: "org_1",
        email: "a@b.com",
        role: MemberRole.OWNER,
        invitedByUserId: "u1",
      }),
    ).rejects.toBeInstanceOf(OnboardingError);

    await expect(
      inviteMember({
        organisationId: "org_1",
        email: "a@b.com",
        role: MemberRole.SUPER_ADMIN,
        invitedByUserId: "u1",
      }),
    ).rejects.toBeInstanceOf(OnboardingError);
  });

  it("inviteMember stores hashed token and does not claim emailSent without SMTP", async () => {
    mocks.organisation.findFirst.mockResolvedValue({ id: "org_1", name: "Acme" });
    mocks.organisationMember.findFirst.mockResolvedValue(null);
    mocks.organisationInvitation.findFirst.mockResolvedValue(null);
    mocks.organisationInvitation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "inv_1",
      ...data,
    }));

    const result = await inviteMember({
      organisationId: "org_1",
      email: "Teammate@Acme.test",
      role: MemberRole.SALES_AGENT,
      invitedByUserId: "owner_1",
      includeInviteUrl: true,
    });

    expect(result.emailSent).toBe(false);
    expect(result.inviteUrl).toMatch(/\/accept-invite\?token=/);
    expect(mocks.organisationInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "teammate@acme.test",
          role: MemberRole.SALES_AGENT,
          status: InvitationStatus.PENDING,
          tokenHash: expect.any(String),
        }),
      }),
    );
    const created = mocks.organisationInvitation.create.mock.calls[0][0].data;
    expect(created.tokenHash).not.toContain("accept-invite");
  });

  it("inviteMember sends email when SMTP is configured", async () => {
    (getEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      APP_URL: "http://localhost:3000",
      EMAIL_SMTP_URL: "smtp://user:pass@localhost:587",
      NODE_ENV: "test",
    });
    const send = vi.fn(async () => ({ ok: true, provider: "smtp", messageId: "x" }));
    (getEmailAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ name: "smtp", send });

    mocks.organisation.findFirst.mockResolvedValue({ id: "org_1", name: "Acme" });
    mocks.organisationMember.findFirst.mockResolvedValue(null);
    mocks.organisationInvitation.findFirst.mockResolvedValue(null);
    mocks.organisationInvitation.create.mockResolvedValue({ id: "inv_2" });

    const result = await inviteMember({
      organisationId: "org_1",
      email: "ok@acme.test",
      role: MemberRole.MANAGER,
      invitedByUserId: "owner_1",
    });

    expect(result.emailSent).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it("acceptInvite rejects expired, revoked, wrong email, and replay", async () => {
    const raw = "a".repeat(40);
    const tokenHash = hashToken(raw);
    const baseInvite = {
      id: "inv_x",
      organisationId: "org_1",
      email: "join@acme.test",
      role: MemberRole.ANALYST,
      tokenHash,
      invitedById: "owner_1",
      organisation: { id: "org_1", name: "Acme", deletedAt: null },
    };

    mocks.organisationInvitation.findUnique.mockResolvedValue({
      ...baseInvite,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      acceptedAt: null,
    });
    mocks.organisationInvitation.update.mockResolvedValue({});
    await expect(
      acceptInvite({ token: raw, email: "join@acme.test", password: "password12345" }),
    ).rejects.toMatchObject({ code: "EXPIRED" });

    mocks.organisationInvitation.findUnique.mockResolvedValue({
      ...baseInvite,
      status: InvitationStatus.REVOKED,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
      acceptedAt: null,
    });
    await expect(
      acceptInvite({ token: raw, email: "join@acme.test", password: "password12345" }),
    ).rejects.toMatchObject({ code: "REVOKED" });

    mocks.organisationInvitation.findUnique.mockResolvedValue({
      ...baseInvite,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      acceptedAt: null,
    });
    await expect(
      acceptInvite({ token: raw, email: "other@acme.test", password: "password12345" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    mocks.organisationInvitation.findUnique.mockResolvedValue({
      ...baseInvite,
      status: InvitationStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      acceptedAt: new Date(),
    });
    await expect(
      acceptInvite({ token: raw, email: "join@acme.test", password: "password12345" }),
    ).rejects.toMatchObject({ code: "REPLAY" });
  });

  it("acceptInvite creates membership and marks ACCEPTED", async () => {
    const raw = "b".repeat(40);
    mocks.organisationInvitation.findUnique.mockResolvedValue({
      id: "inv_ok",
      organisationId: "org_1",
      email: "new@acme.test",
      role: MemberRole.READ_ONLY,
      tokenHash: hashToken(raw),
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      acceptedAt: null,
      invitedById: "owner_1",
      organisation: { id: "org_1", name: "Acme", deletedAt: null },
    });
    mocks.user.findFirst.mockResolvedValue(null);
    mocks.user.create.mockResolvedValue({
      id: "user_new",
      email: "new@acme.test",
      name: null,
      passwordHash: "hashed:password12345",
    });
    mocks.organisationMember.findUnique.mockResolvedValue(null);
    mocks.organisationMember.create.mockResolvedValue({ id: "mem_1" });
    mocks.organisationInvitation.update.mockResolvedValue({});

    const result = await acceptInvite({
      token: raw,
      email: "New@Acme.test",
      password: "password12345",
      name: "New User",
    });

    expect(result.userId).toBe("user_new");
    expect(result.role).toBe(MemberRole.READ_ONLY);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("resend/revoke are organisation-scoped (cross-org not found)", async () => {
    mocks.organisationInvitation.findFirst.mockResolvedValue(null);

    await expect(
      resendInvite({
        organisationId: "org_a",
        inviteId: "inv_from_b",
        invitedByUserId: "u1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      revokeInvite({
        organisationId: "org_a",
        inviteId: "inv_from_b",
        revokedByUserId: "u1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("changeMemberRole protects last OWNER and blocks SUPER_ADMIN", async () => {
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_1",
      organisationId: "org_1",
      userId: "owner_1",
      role: MemberRole.OWNER,
      user: { isPlatformAdmin: false, email: "o@acme.test" },
    });
    mocks.organisationMember.count.mockResolvedValue(1);

    await expect(
      changeMemberRole({
        organisationId: "org_1",
        userId: "owner_1",
        role: MemberRole.MANAGER,
        actorUserId: "owner_1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      changeMemberRole({
        organisationId: "org_1",
        userId: "owner_1",
        role: MemberRole.SUPER_ADMIN,
        actorUserId: "owner_1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("changeMemberRole can transfer ownership when another OWNER exists", async () => {
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_mgr",
      organisationId: "org_1",
      userId: "mgr_1",
      role: MemberRole.MANAGER,
      user: { isPlatformAdmin: false, email: "m@acme.test" },
    });
    mocks.organisationMember.update.mockResolvedValue({
      id: "mem_mgr",
      userId: "mgr_1",
      role: MemberRole.OWNER,
    });

    const updated = await changeMemberRole({
      organisationId: "org_1",
      userId: "mgr_1",
      role: MemberRole.OWNER,
      actorUserId: "owner_1",
    });
    expect(updated.role).toBe(MemberRole.OWNER);
  });

  it("removeMember refuses last OWNER", async () => {
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_1",
      organisationId: "org_1",
      userId: "owner_1",
      role: MemberRole.OWNER,
    });
    mocks.organisationMember.count.mockResolvedValue(1);

    await expect(
      removeMember({
        organisationId: "org_1",
        userId: "owner_1",
        actorUserId: "owner_1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("removeMember deletes membership for non-last owners", async () => {
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_2",
      organisationId: "org_1",
      userId: "agent_1",
      role: MemberRole.SALES_AGENT,
    });
    mocks.organisationMember.delete.mockResolvedValue({});
    mocks.user.findUnique.mockResolvedValue({
      id: "agent_1",
      activeOrganisationId: "org_1",
    });
    mocks.organisationMember.findFirst.mockResolvedValue(null);
    mocks.user.update.mockResolvedValue({});

    const result = await removeMember({
      organisationId: "org_1",
      userId: "agent_1",
      actorUserId: "owner_1",
    });
    expect(result.removed).toBe(true);
    expect(mocks.organisationMember.delete).toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.member.remove" }),
    );
  });

  it("removeMember deletes READ_ONLY membership and retains audit", async () => {
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_ro",
      organisationId: "org_qa",
      userId: "ro_1",
      role: MemberRole.READ_ONLY,
    });
    mocks.organisationMember.delete.mockResolvedValue({});
    mocks.user.findUnique.mockResolvedValue({
      id: "ro_1",
      activeOrganisationId: "org_qa",
    });
    mocks.organisationMember.findFirst.mockResolvedValue(null);
    mocks.user.update.mockResolvedValue({});

    const result = await removeMember({
      organisationId: "org_qa",
      userId: "ro_1",
      actorUserId: "owner_1",
    });
    expect(result.removed).toBe(true);
    expect(mocks.organisationMember.delete).toHaveBeenCalledWith({ where: { id: "mem_ro" } });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.member.remove",
        metadata: expect.objectContaining({ targetUserId: "ro_1", role: MemberRole.READ_ONLY }),
      }),
    );
  });

  it("platform-admin flag is not assigned via role change (isolation)", async () => {
    // changeMemberRole never writes user.isPlatformAdmin — only MemberRole.
    mocks.organisationMember.findUnique.mockResolvedValue({
      id: "mem_p",
      organisationId: "org_1",
      userId: "user_p",
      role: MemberRole.ADMINISTRATOR,
      user: { isPlatformAdmin: true, email: "p@acme.test" },
    });
    mocks.organisationMember.update.mockResolvedValue({
      id: "mem_p",
      userId: "user_p",
      role: MemberRole.MANAGER,
    });

    await changeMemberRole({
      organisationId: "org_1",
      userId: "user_p",
      role: MemberRole.MANAGER,
      actorUserId: "owner_1",
    });

    expect(mocks.organisationMember.update).toHaveBeenCalledWith({
      where: { id: "mem_p" },
      data: { role: MemberRole.MANAGER },
    });
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
});
