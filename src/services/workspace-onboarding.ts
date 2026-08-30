import { createHash, randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  InvitationStatus,
  MemberRole,
  OrganisationStatus,
  type OrganisationInvitation,
  type OrganisationMember,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getEmailAdapter } from "@/adapters/email";
import { writeAuditLog } from "@/services/audit";

/** Roles that can be assigned via workspace invite (OWNER is only via createWorkspace). */
export const INVITE_ROLES: MemberRole[] = [
  MemberRole.ADMINISTRATOR,
  MemberRole.MANAGER,
  MemberRole.SALES_AGENT,
  MemberRole.ANALYST,
  MemberRole.READ_ONLY,
];

/** Roles that can be set via changeMemberRole (includes OWNER for ownership transfer). */
export const ASSIGNABLE_MEMBER_ROLES: MemberRole[] = [
  MemberRole.OWNER,
  ...INVITE_ROLES,
];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class OnboardingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "VALIDATION"
      | "CONFLICT"
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "EXPIRED"
      | "REVOKED"
      | "REPLAY" = "VALIDATION",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "workspace";
}

async function uniqueSlug(preferred: string): Promise<string> {
  let candidate = preferred.slice(0, 80);
  for (let i = 0; i < 20; i++) {
    const existing = await prisma.organisation.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    const suffix = randomBytes(2).toString("hex");
    candidate = `${preferred.slice(0, 72)}-${suffix}`;
  }
  throw new OnboardingError("Could not allocate a unique workspace slug", "CONFLICT");
}

function assertInviteRole(role: MemberRole): void {
  if (!INVITE_ROLES.includes(role)) {
    throw new OnboardingError(
      `Invite role must be one of: ${INVITE_ROLES.join(", ")} (OWNER is not invitible)`,
      "VALIDATION",
    );
  }
}

function assertAssignableRole(role: MemberRole): void {
  if (role === MemberRole.SUPER_ADMIN) {
    throw new OnboardingError("SUPER_ADMIN is not a workspace-assignable role", "FORBIDDEN");
  }
  if (!ASSIGNABLE_MEMBER_ROLES.includes(role)) {
    throw new OnboardingError(`Role ${role} cannot be assigned`, "VALIDATION");
  }
}

function appBaseUrl(): string {
  const env = getEnv();
  return (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

function inviteUrlForToken(rawToken: string): string {
  return `${appBaseUrl()}/accept-invite?token=${rawToken}`;
}

function smtpConfigured(): boolean {
  return Boolean(getEnv().EMAIL_SMTP_URL);
}

async function countOwners(organisationId: string): Promise<number> {
  return prisma.organisationMember.count({
    where: { organisationId, role: MemberRole.OWNER },
  });
}

const DEFAULT_PIPELINE_STAGES = [
  { name: "New", slug: "new", position: 0 },
  { name: "Contacted", slug: "contacted", position: 1 },
  { name: "Engaged", slug: "engaged", position: 2 },
  { name: "Qualifying", slug: "qualifying", position: 3 },
  { name: "Qualified", slug: "qualified", position: 4 },
  { name: "Booking Link Sent", slug: "booking_offered", position: 5 },
  { name: "Booked", slug: "booked", position: 6 },
  { name: "Won", slug: "won", position: 7, isWon: true },
  { name: "Disqualified", slug: "disqualified", position: 8, isLost: true },
];

export type CreateWorkspaceInput = {
  name: string;
  slug?: string;
  ownerEmail: string;
  ownerName?: string | null;
  password?: string;
  /** When set, attach this existing user as OWNER (password optional). */
  existingUserId?: string;
  timezone?: string;
};

export async function createWorkspaceWithOwner(input: CreateWorkspaceInput) {
  const name = input.name.trim();
  if (name.length < 2) throw new OnboardingError("Workspace name is required");

  const ownerEmail = normalizeEmail(input.ownerEmail);
  if (!ownerEmail.includes("@")) throw new OnboardingError("Valid owner email is required");

  const preferredSlug = input.slug?.trim().toLowerCase() || slugify(name);
  if (!/^[a-z0-9-]+$/.test(preferredSlug)) {
    throw new OnboardingError("Slug must be lowercase alphanumeric with hyphens");
  }
  const slug = await uniqueSlug(preferredSlug);

  let user =
    (input.existingUserId
      ? await prisma.user.findFirst({
          where: { id: input.existingUserId, deletedAt: null },
        })
      : null) ??
    (await prisma.user.findFirst({
      where: { email: ownerEmail, deletedAt: null },
    }));

  // Session path: bind to the authenticated user even if body email differs.
  const effectiveEmail = user?.email ?? ownerEmail;

  if (!user) {
    if (!input.password || input.password.length < 10) {
      throw new OnboardingError("Password must be at least 10 characters for new accounts");
    }
    const passwordHash = await hash(input.password, 12);
    user = await prisma.user.create({
      data: {
        email: effectiveEmail,
        name: input.ownerName?.trim() || null,
        passwordHash,
        emailVerified: new Date(),
        isActive: true,
      },
    });
  } else {
    const updates: {
      name?: string | null;
      passwordHash?: string;
      isActive?: boolean;
      emailVerified?: Date;
    } = {};
    if (input.ownerName?.trim() && !user.name) {
      updates.name = input.ownerName.trim();
    }
    if (!user.passwordHash) {
      if (!input.password || input.password.length < 10) {
        throw new OnboardingError(
          "Password must be at least 10 characters to set password on existing account",
        );
      }
      updates.passwordHash = await hash(input.password, 12);
      updates.emailVerified = new Date();
    }
    if (!user.isActive) updates.isActive = true;
    if (Object.keys(updates).length > 0) {
      user = await prisma.user.update({ where: { id: user.id }, data: updates });
    }
  }

  const org = await prisma.organisation.create({
    data: {
      name,
      slug,
      timezone: input.timezone || "UTC",
      status: OrganisationStatus.ACTIVE,
      autopilotMode: "OFF",
      pipelines: {
        create: {
          name: "Default",
          isDefault: true,
          stages: { create: DEFAULT_PIPELINE_STAGES },
        },
      },
      agentConfigurations: {
        create: {
          name: "Default Agent",
          isActive: true,
        },
      },
      members: {
        create: {
          userId: user.id,
          role: MemberRole.OWNER,
        },
      },
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { activeOrganisationId: org.id },
  });

  await writeAuditLog({
    organisationId: org.id,
    userId: user.id,
    action: "workspace.onboarding.create",
    entityType: "Organisation",
    entityId: org.id,
    metadata: { name: org.name, slug: org.slug, ownerEmail: effectiveEmail },
  });

  return {
    organisation: { id: org.id, name: org.name, slug: org.slug },
    user: { id: user.id, email: user.email, name: user.name },
    role: MemberRole.OWNER,
  };
}

export type InviteMemberInput = {
  organisationId: string;
  email: string;
  role: MemberRole;
  invitedByUserId: string;
  /** When true, always include inviteUrl for copy-link (members:manage callers). */
  includeInviteUrl?: boolean;
};

export type InviteMemberResult = {
  inviteId: string;
  emailSent: boolean;
  inviteUrl?: string;
  emailError?: string;
};

async function sendInviteEmail(params: {
  organisationId: string;
  organisationName: string;
  to: string;
  inviteUrl: string;
  role: MemberRole;
}): Promise<{ emailSent: boolean; emailError?: string }> {
  if (!smtpConfigured()) {
    return {
      emailSent: false,
      emailError: "EMAIL_SMTP_URL is not configured — share the invite link manually",
    };
  }

  const delivery = await getEmailAdapter().send({
    organisationId: params.organisationId,
    to: [params.to],
    subject: `You're invited to ${params.organisationName} on Agent Desk`,
    bodyText: [
      `You've been invited to join ${params.organisationName} as ${params.role}.`,
      "",
      "Open this link to accept (expires in 7 days):",
      params.inviteUrl,
      "",
      "If you did not expect this invitation, you can ignore this email.",
    ].join("\n"),
    metadata: { kind: "workspace_invite", role: params.role },
  });

  if (!delivery.ok) {
    logger.error("Workspace invite email failed", {
      organisationId: params.organisationId,
      error: delivery.error,
    });
    return { emailSent: false, emailError: delivery.error || "Email send failed" };
  }
  return { emailSent: true };
}

export async function inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
  assertInviteRole(input.role);
  const email = normalizeEmail(input.email);

  const org = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
  });
  if (!org) throw new OnboardingError("Workspace not found", "NOT_FOUND");

  const existingMember = await prisma.organisationMember.findFirst({
    where: {
      organisationId: input.organisationId,
      user: { email },
    },
  });
  if (existingMember) {
    throw new OnboardingError("User is already a member of this workspace", "CONFLICT");
  }

  const pending = await prisma.organisationInvitation.findFirst({
    where: {
      organisationId: input.organisationId,
      email,
      status: InvitationStatus.PENDING,
    },
  });
  if (pending && pending.expiresAt > new Date()) {
    throw new OnboardingError(
      "A pending invitation already exists for this email — resend or revoke it first",
      "CONFLICT",
    );
  }
  if (pending) {
    await prisma.organisationInvitation.update({
      where: { id: pending.id },
      data: { status: InvitationStatus.EXPIRED },
    });
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invite = await prisma.organisationInvitation.create({
    data: {
      organisationId: input.organisationId,
      email,
      role: input.role,
      tokenHash,
      status: InvitationStatus.PENDING,
      invitedById: input.invitedByUserId,
      expiresAt,
    },
  });

  const inviteUrl = inviteUrlForToken(rawToken);
  const { emailSent, emailError } = await sendInviteEmail({
    organisationId: org.id,
    organisationName: org.name,
    to: email,
    inviteUrl,
    role: input.role,
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.invitedByUserId,
    action: "workspace.invite.create",
    entityType: "OrganisationInvitation",
    entityId: invite.id,
    metadata: { email, role: input.role, emailSent },
  });

  const result: InviteMemberResult = {
    inviteId: invite.id,
    emailSent,
  };
  if (!emailSent || input.includeInviteUrl) {
    result.inviteUrl = inviteUrl;
  }
  if (emailError) result.emailError = emailError;
  return result;
}

export async function resendInvite(input: {
  organisationId: string;
  inviteId: string;
  invitedByUserId: string;
  includeInviteUrl?: boolean;
}): Promise<InviteMemberResult> {
  const invite = await prisma.organisationInvitation.findFirst({
    where: { id: input.inviteId, organisationId: input.organisationId },
    include: { organisation: { select: { name: true } } },
  });
  if (!invite) throw new OnboardingError("Invitation not found", "NOT_FOUND");
  if (invite.status === InvitationStatus.ACCEPTED) {
    throw new OnboardingError("Invitation already accepted", "REPLAY");
  }
  if (invite.status === InvitationStatus.REVOKED) {
    throw new OnboardingError("Invitation was revoked", "REVOKED");
  }

  assertInviteRole(invite.role);

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await prisma.organisationInvitation.update({
    where: { id: invite.id },
    data: {
      tokenHash,
      status: InvitationStatus.PENDING,
      expiresAt,
      revokedAt: null,
    },
  });

  const inviteUrl = inviteUrlForToken(rawToken);
  const { emailSent, emailError } = await sendInviteEmail({
    organisationId: input.organisationId,
    organisationName: invite.organisation.name,
    to: invite.email,
    inviteUrl,
    role: invite.role,
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.invitedByUserId,
    action: "workspace.invite.resend",
    entityType: "OrganisationInvitation",
    entityId: invite.id,
    metadata: { email: invite.email, emailSent },
  });

  const result: InviteMemberResult = { inviteId: invite.id, emailSent };
  if (!emailSent || input.includeInviteUrl) result.inviteUrl = inviteUrl;
  if (emailError) result.emailError = emailError;
  return result;
}

export async function revokeInvite(input: {
  organisationId: string;
  inviteId: string;
  revokedByUserId: string;
}): Promise<{ inviteId: string }> {
  const invite = await prisma.organisationInvitation.findFirst({
    where: { id: input.inviteId, organisationId: input.organisationId },
  });
  if (!invite) throw new OnboardingError("Invitation not found", "NOT_FOUND");
  if (invite.status === InvitationStatus.ACCEPTED) {
    throw new OnboardingError("Cannot revoke an accepted invitation", "CONFLICT");
  }
  if (invite.status === InvitationStatus.REVOKED) {
    return { inviteId: invite.id };
  }

  await prisma.organisationInvitation.update({
    where: { id: invite.id },
    data: {
      status: InvitationStatus.REVOKED,
      revokedAt: new Date(),
    },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.revokedByUserId,
    action: "workspace.invite.revoke",
    entityType: "OrganisationInvitation",
    entityId: invite.id,
    metadata: { email: invite.email },
  });

  return { inviteId: invite.id };
}

export type AcceptInviteInput = {
  token: string;
  email: string;
  name?: string | null;
  password?: string;
};

export async function acceptInvite(input: AcceptInviteInput) {
  if (!input.token || input.token.length < 20) {
    throw new OnboardingError("Invalid invitation token");
  }
  const email = normalizeEmail(input.email);
  const tokenHash = hashToken(input.token);

  const invite = await prisma.organisationInvitation.findUnique({
    where: { tokenHash },
    include: { organisation: { select: { id: true, name: true, deletedAt: true } } },
  });

  if (!invite) throw new OnboardingError("Invalid or expired invitation", "NOT_FOUND");
  if (invite.status === InvitationStatus.ACCEPTED) {
    throw new OnboardingError("Invitation already accepted", "REPLAY");
  }
  if (invite.status === InvitationStatus.REVOKED || invite.revokedAt) {
    throw new OnboardingError("Invitation was revoked", "REVOKED");
  }
  if (invite.expiresAt < new Date() || invite.status === InvitationStatus.EXPIRED) {
    if (invite.status === InvitationStatus.PENDING) {
      await prisma.organisationInvitation.update({
        where: { id: invite.id },
        data: { status: InvitationStatus.EXPIRED },
      });
    }
    throw new OnboardingError("Invitation has expired", "EXPIRED");
  }
  if (invite.organisation.deletedAt) {
    throw new OnboardingError("Workspace is no longer available", "NOT_FOUND");
  }
  if (normalizeEmail(invite.email) !== email) {
    throw new OnboardingError("Email does not match this invitation", "FORBIDDEN");
  }

  let user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
  });

  if (!user) {
    if (!input.password || input.password.length < 10) {
      throw new OnboardingError("Password must be at least 10 characters for new accounts");
    }
    const passwordHash = await hash(input.password, 12);
    user = await prisma.user.create({
      data: {
        email,
        name: input.name?.trim() || null,
        passwordHash,
        emailVerified: new Date(),
        isActive: true,
        activeOrganisationId: invite.organisationId,
      },
    });
  } else {
    const updates: {
      name?: string | null;
      passwordHash?: string;
      activeOrganisationId?: string;
      isActive?: boolean;
    } = { activeOrganisationId: invite.organisationId };
    if (input.name?.trim() && !user.name) updates.name = input.name.trim();
    if (!user.passwordHash) {
      if (!input.password || input.password.length < 10) {
        throw new OnboardingError(
          "Password must be at least 10 characters to set password on existing account",
        );
      }
      updates.passwordHash = await hash(input.password, 12);
    }
    if (!user.isActive) updates.isActive = true;
    user = await prisma.user.update({ where: { id: user.id }, data: updates });
  }

  const existingMembership = await prisma.organisationMember.findUnique({
    where: {
      organisationId_userId: {
        organisationId: invite.organisationId,
        userId: user.id,
      },
    },
  });
  if (existingMembership) {
    // Mark accepted to prevent replay, but do not duplicate membership.
    await prisma.organisationInvitation.update({
      where: { id: invite.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
      },
    });
    throw new OnboardingError("You are already a member of this workspace", "CONFLICT");
  }

  await prisma.$transaction([
    prisma.organisationMember.create({
      data: {
        organisationId: invite.organisationId,
        userId: user.id,
        role: invite.role,
      },
    }),
    prisma.organisationInvitation.update({
      where: { id: invite.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
      },
    }),
  ]);

  await writeAuditLog({
    organisationId: invite.organisationId,
    userId: user.id,
    action: "workspace.invite.accept",
    entityType: "OrganisationInvitation",
    entityId: invite.id,
    metadata: { email, role: invite.role },
  });

  return {
    organisationId: invite.organisationId,
    organisationName: invite.organisation.name,
    userId: user.id,
    role: invite.role,
  };
}

export async function listMembers(organisationId: string) {
  return prisma.organisationMember.findMany({
    where: { organisationId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          isPlatformAdmin: true,
        },
      },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
}

export async function listPendingInvites(organisationId: string) {
  const now = new Date();
  const invites = await prisma.organisationInvitation.findMany({
    where: {
      organisationId,
      status: InvitationStatus.PENDING,
    },
    orderBy: { createdAt: "desc" },
  });

  // Lazily mark expired for visibility.
  const fresh: OrganisationInvitation[] = [];
  for (const invite of invites) {
    if (invite.expiresAt < now) {
      await prisma.organisationInvitation.update({
        where: { id: invite.id },
        data: { status: InvitationStatus.EXPIRED },
      });
    } else {
      fresh.push(invite);
    }
  }
  return fresh;
}

export async function changeMemberRole(input: {
  organisationId: string;
  userId: string;
  role: MemberRole;
  actorUserId: string;
}): Promise<OrganisationMember> {
  assertAssignableRole(input.role);

  const member = await prisma.organisationMember.findUnique({
    where: {
      organisationId_userId: {
        organisationId: input.organisationId,
        userId: input.userId,
      },
    },
    include: { user: { select: { isPlatformAdmin: true, email: true } } },
  });
  if (!member) throw new OnboardingError("Member not found", "NOT_FOUND");

  // isPlatformAdmin is a platform flag — never assignable via workspace role change.
  // We only change MemberRole; never touch user.isPlatformAdmin.

  if (member.role === MemberRole.OWNER && input.role !== MemberRole.OWNER) {
    const owners = await countOwners(input.organisationId);
    if (owners <= 1) {
      throw new OnboardingError("Cannot demote the last OWNER", "FORBIDDEN");
    }
  }

  const updated = await prisma.organisationMember.update({
    where: { id: member.id },
    data: { role: input.role },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId,
    action: "workspace.member.role_change",
    entityType: "OrganisationMember",
    entityId: member.id,
    metadata: {
      targetUserId: input.userId,
      from: member.role,
      to: input.role,
    },
  });

  return updated;
}

export async function removeMember(input: {
  organisationId: string;
  userId: string;
  actorUserId: string;
}): Promise<{ removed: true }> {
  const member = await prisma.organisationMember.findUnique({
    where: {
      organisationId_userId: {
        organisationId: input.organisationId,
        userId: input.userId,
      },
    },
  });
  if (!member) throw new OnboardingError("Member not found", "NOT_FOUND");

  if (member.role === MemberRole.OWNER) {
    const owners = await countOwners(input.organisationId);
    if (owners <= 1) {
      throw new OnboardingError("Cannot remove the last OWNER", "FORBIDDEN");
    }
  }

  await prisma.organisationMember.delete({ where: { id: member.id } });

  // Clear active org if it pointed at this workspace.
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (user?.activeOrganisationId === input.organisationId) {
    const other = await prisma.organisationMember.findFirst({
      where: { userId: input.userId },
      orderBy: { createdAt: "asc" },
    });
    await prisma.user.update({
      where: { id: input.userId },
      data: { activeOrganisationId: other?.organisationId ?? null },
    });
  }

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.actorUserId,
    action: "workspace.member.remove",
    entityType: "OrganisationMember",
    entityId: member.id,
    metadata: { targetUserId: input.userId, role: member.role },
  });

  return { removed: true };
}

/** Lookup invite by raw token for public accept page (no side effects beyond expiry mark). */
export async function getInviteByToken(rawToken: string) {
  if (!rawToken || rawToken.length < 20) return null;
  const invite = await prisma.organisationInvitation.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: {
      organisation: { select: { id: true, name: true, deletedAt: true } },
    },
  });
  if (!invite) return null;
  if (invite.status === InvitationStatus.PENDING && invite.expiresAt < new Date()) {
    await prisma.organisationInvitation.update({
      where: { id: invite.id },
      data: { status: InvitationStatus.EXPIRED },
    });
    return { ...invite, status: InvitationStatus.EXPIRED };
  }
  return invite;
}
