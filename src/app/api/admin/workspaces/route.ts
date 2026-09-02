/**
 * Platform Admin — Organisations / Workspaces API
 * Create beta workspaces, suspend/reactivate, list with beta + social policy.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { InvitationStatus, MemberRole, OrganisationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { assertOrganisationMutable } from "@/lib/platform-org";
import { softDeleteOrganisation } from "@/services/organisation-lifecycle";
import {
  createBetaWorkspaceAndInvite,
  OnboardingError,
  resendInvite,
  revokeInvite,
} from "@/services/workspace-onboarding";
import {
  countConnectedSocialAccounts,
  getBetaWorkspaceMeta,
  setBetaWorkspaceMeta,
  AI_BUDGET_WARNING_PREF_KEY,
  getAiBudgetWarningThresholdCents,
} from "@/services/beta-workspace";
import {
  getSocialConnectionPolicy,
  SOCIAL_CONNECTION_POLICY_KEY,
} from "@/services/social-connection-policy";
import { setOrganisationAiBudget } from "@/services/ai-spend-gate";
import { setOrganisationPreference } from "@/services/agent-memory";

const createBetaSchema = z.object({
  action: z.literal("create_beta"),
  name: z.string().min(2).max(120),
  ownerFullName: z.string().min(2).max(120),
  ownerEmail: z.string().email(),
  role: z
    .enum(["OWNER", "ADMINISTRATOR", "MANAGER", "SALES_AGENT", "ANALYST", "READ_ONLY"])
    .optional(),
  betaLabel: z.string().max(80).optional(),
  betaExpiresAt: z.string().datetime().optional().nullable(),
  internalNotes: z.string().max(2000).optional().nullable(),
  socialConnectionsEnabled: z.boolean().optional(),
  maxConnectedSocialAccounts: z.number().int().min(0).max(50).nullable().optional(),
  allowedNetworks: z
    .array(z.enum(["INSTAGRAM", "LINKEDIN", "YOUTUBE"]))
    .min(1)
    .optional(),
});

const createSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  timezone: z.string().optional(),
  ownerEmail: z.string().email().optional(),
});

const mutateSchema = z.object({
  action: z.enum([
    "suspend",
    "reactivate",
    "update",
    "archive",
    "set_ai_budget",
    "invite",
    "resend_invite",
    "revoke_invite",
    "set_beta_status",
  ]),
  organisationId: z.string().min(1),
  name: z.string().min(2).max(120).optional(),
  timezone: z.string().optional(),
  plan: z.string().optional(),
  reason: z.string().max(500).optional(),
  monthlyCapCents: z.number().int().min(0).nullable().optional(),
  warningThresholdCents: z.number().int().min(0).nullable().optional(),
  inviteEmail: z.string().email().optional(),
  inviteRole: z
    .enum(["OWNER", "ADMINISTRATOR", "MANAGER", "SALES_AGENT", "ANALYST", "READ_ONLY"])
    .optional(),
  inviteId: z.string().optional(),
  betaStatus: z.enum(["BETA_ACTIVE", "BETA_SUSPENDED", "BETA_COMPLETED"]).optional(),
});

export async function GET() {
  try {
    await requirePlatformAccess();
    const orgs = await prisma.organisation.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        members: {
          where: { role: { in: [MemberRole.OWNER, MemberRole.SUPER_ADMIN] } },
          include: { user: { select: { id: true, email: true, name: true } } },
          take: 3,
        },
        integrations: { select: { type: true, isActive: true } },
        agentConfigurations: {
          where: { isActive: true },
          select: { id: true, aiProvider: true },
          take: 1,
        },
        invitations: {
          where: { status: InvitationStatus.PENDING },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        organisationPreferences: {
          where: {
            key: {
              in: ["beta_workspace", SOCIAL_CONNECTION_POLICY_KEY, AI_BUDGET_WARNING_PREF_KEY],
            },
          },
        },
        aiBudget: true,
        _count: {
          select: {
            members: true,
            contacts: true,
            conversations: true,
            leads: true,
            invitations: true,
          },
        },
      },
    });

    const workspaces = await Promise.all(
      orgs.map(async (org) => {
        const owner = org.members[0]?.user;
        const manychat = org.integrations.find((i) => i.type === "MANYCHAT");
        const booking = org.integrations.find((i) => i.type === "BOOKING");
        const beta = await getBetaWorkspaceMeta(org.id);
        const socialPolicy = await getSocialConnectionPolicy(org.id);
        const connectedSocialCount = await countConnectedSocialAccounts(org.id);
        const warningCents = await getAiBudgetWarningThresholdCents(org.id);
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          plan: org.plan,
          status: org.status,
          isPlatform: org.isPlatform,
          autopilotMode: org.autopilotMode,
          demoData: org.demoData,
          timezone: org.timezone,
          createdAt: org.createdAt.toISOString(),
          lastActivityAt: org.lastActivityAt?.toISOString() ?? null,
          owner: owner
            ? { id: owner.id, email: owner.email, name: owner.name }
            : null,
          users: org._count.members,
          contacts: org._count.contacts,
          conversations: org._count.conversations,
          leads: org._count.leads,
          aiStatus: org.agentConfigurations[0] ? "Configured" : "Not configured",
          manychatStatus: manychat?.isActive ? "Connected" : "Not connected",
          bookingStatus: booking?.isActive ? "Connected" : "Not connected",
          betaStatus: beta?.status ?? (org.plan === "beta" ? "BETA_ACTIVE" : null),
          betaLabel: beta?.label ?? null,
          connectedSocialCount,
          socialLimit: socialPolicy.maxConnectedSocialAccounts,
          socialConnectionsEnabled: socialPolicy.socialConnectionsEnabled,
          allowedNetworks: socialPolicy.allowedNetworks,
          pendingInvites: org.invitations,
          aiBudgetMonthlyCapCents: org.aiBudget?.monthlyCapCents ?? null,
          aiBudgetWarningThresholdCents: warningCents,
        };
      }),
    );

    return Response.json({ workspaces });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = z
      .union([createBetaSchema, createSchema, mutateSchema])
      .parse(await req.json());

    if (body.action === "create_beta") {
      const result = await createBetaWorkspaceAndInvite({
        name: body.name,
        ownerFullName: body.ownerFullName,
        ownerEmail: body.ownerEmail,
        role: (body.role as MemberRole | undefined) ?? MemberRole.OWNER,
        betaLabel: body.betaLabel,
        betaExpiresAt: body.betaExpiresAt ?? null,
        internalNotes: body.internalNotes ?? null,
        socialConnectionsEnabled: body.socialConnectionsEnabled,
        maxConnectedSocialAccounts: body.maxConnectedSocialAccounts,
        allowedNetworks: body.allowedNetworks,
        createdByUserId: session.userId,
      });
      return Response.json({ ok: true, ...result });
    }

    if (body.action === "create") {
      const existing = await prisma.organisation.findUnique({ where: { slug: body.slug } });
      if (existing) return jsonError("Slug already in use", 409);

      const org = await prisma.organisation.create({
        data: {
          name: body.name,
          slug: body.slug,
          timezone: body.timezone || "UTC",
          status: OrganisationStatus.ACTIVE,
          autopilotMode: "OFF",
          pipelines: {
            create: {
              name: "Default",
              isDefault: true,
              stages: {
                create: [
                  { name: "New", slug: "new", position: 0 },
                  { name: "Contacted", slug: "contacted", position: 1 },
                  { name: "Engaged", slug: "engaged", position: 2 },
                  { name: "Qualifying", slug: "qualifying", position: 3 },
                  { name: "Qualified", slug: "qualified", position: 4 },
                  { name: "Booking Link Sent", slug: "booking_offered", position: 5 },
                  { name: "Booked", slug: "booked", position: 6 },
                  { name: "Won", slug: "won", position: 7, isWon: true },
                  { name: "Disqualified", slug: "disqualified", position: 8, isLost: true },
                ],
              },
            },
          },
          agentConfigurations: {
            create: {
              name: "Default Agent",
              isActive: true,
            },
          },
        },
      });

      if (body.ownerEmail) {
        const user = await prisma.user.findUnique({
          where: { email: body.ownerEmail.toLowerCase() },
        });
        if (user) {
          await prisma.organisationMember.create({
            data: {
              organisationId: org.id,
              userId: user.id,
              role: MemberRole.OWNER,
            },
          });
          await prisma.user.update({
            where: { id: user.id },
            data: { activeOrganisationId: org.id },
          });
        }
      }

      const { ensureNewOrgSocialConnectionPolicy } = await import(
        "@/services/social-connection-policy"
      );
      await ensureNewOrgSocialConnectionPolicy(org.id);

      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.create",
        entityType: "Organisation",
        entityId: org.id,
        metadata: { name: org.name, slug: org.slug },
      });

      return Response.json({
        ok: true,
        workspace: { id: org.id, name: org.name, slug: org.slug },
      });
    }

    const org = await prisma.organisation.findFirst({
      where: { id: body.organisationId, deletedAt: null },
    });
    if (!org) return jsonError("Workspace not found", 404);

    if (body.action === "suspend") {
      try {
        await assertOrganisationMutable(org.id);
      } catch (error) {
        return jsonError(
          error instanceof Error ? error.message : "Organisation is protected",
          403,
        );
      }
      const updated = await prisma.organisation.update({
        where: { id: org.id },
        data: { status: OrganisationStatus.SUSPENDED, autopilotMode: "PAUSED" },
      });
      const beta = await getBetaWorkspaceMeta(org.id);
      if (beta) {
        await setBetaWorkspaceMeta({
          organisationId: org.id,
          meta: { ...beta, status: "BETA_SUSPENDED" },
          updatedByUserId: session.userId,
        });
      }
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.suspend",
        entityType: "Organisation",
        entityId: org.id,
        metadata: { reason: body.reason ?? null, preserveSocial: true },
      });
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.action === "reactivate") {
      const updated = await prisma.organisation.update({
        where: { id: org.id },
        data: { status: OrganisationStatus.ACTIVE },
      });
      const beta = await getBetaWorkspaceMeta(org.id);
      if (beta) {
        await setBetaWorkspaceMeta({
          organisationId: org.id,
          meta: { ...beta, status: "BETA_ACTIVE" },
          updatedByUserId: session.userId,
        });
      }
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.reactivate",
        entityType: "Organisation",
        entityId: org.id,
      });
      return Response.json({ ok: true, status: updated.status });
    }

    if (body.action === "archive") {
      const result = await softDeleteOrganisation({
        organisationId: org.id,
        actorUserId: session.userId,
        reason: body.reason,
      });
      return Response.json({
        ok: true,
        archived: true,
        deletedAt: result.deletedAt.toISOString(),
      });
    }

    if (body.action === "set_ai_budget") {
      const budget = await setOrganisationAiBudget({
        organisationId: org.id,
        monthlyCapCents: body.monthlyCapCents ?? null,
      });
      if (body.warningThresholdCents !== undefined) {
        await setOrganisationPreference({
          organisationId: org.id,
          key: AI_BUDGET_WARNING_PREF_KEY,
          value: { cents: body.warningThresholdCents },
          updatedByUserId: session.userId,
        });
      }
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.ai_budget.set",
        entityType: "OrganisationAiBudget",
        entityId: budget.id,
        metadata: {
          monthlyCapCents: budget.monthlyCapCents,
          warningThresholdCents: body.warningThresholdCents ?? null,
        },
      });
      return Response.json({
        ok: true,
        monthlyCapCents: budget.monthlyCapCents,
        warningThresholdCents: body.warningThresholdCents ?? null,
      });
    }

    if (body.action === "set_beta_status") {
      if (!body.betaStatus) return jsonError("betaStatus required", 400);
      const existing = (await getBetaWorkspaceMeta(org.id)) ?? {
        status: "BETA_ACTIVE" as const,
        label: "Beta",
      };
      await setBetaWorkspaceMeta({
        organisationId: org.id,
        meta: { ...existing, status: body.betaStatus },
        updatedByUserId: session.userId,
      });
      if (body.betaStatus === "BETA_SUSPENDED") {
        await prisma.organisation.update({
          where: { id: org.id },
          data: { status: OrganisationStatus.SUSPENDED, autopilotMode: "PAUSED" },
        });
      } else if (body.betaStatus === "BETA_ACTIVE") {
        await prisma.organisation.update({
          where: { id: org.id },
          data: { status: OrganisationStatus.ACTIVE },
        });
      }
      await writeAuditLog({
        organisationId: org.id,
        userId: session.userId,
        action: "workspace.beta.status",
        entityType: "Organisation",
        entityId: org.id,
        metadata: { status: body.betaStatus },
      });
      return Response.json({ ok: true, betaStatus: body.betaStatus });
    }

    if (body.action === "invite") {
      if (!body.inviteEmail) return jsonError("inviteEmail required", 400);
      const { inviteMember } = await import("@/services/workspace-onboarding");
      const invite = await inviteMember({
        organisationId: org.id,
        email: body.inviteEmail,
        role: (body.inviteRole as MemberRole | undefined) ?? MemberRole.OWNER,
        invitedByUserId: session.userId,
        includeInviteUrl: true,
        allowOwnerRole: true,
      });
      return Response.json({ ok: true, invite });
    }

    if (body.action === "resend_invite") {
      if (!body.inviteId) return jsonError("inviteId required", 400);
      const invite = await resendInvite({
        organisationId: org.id,
        inviteId: body.inviteId,
        invitedByUserId: session.userId,
        includeInviteUrl: true,
      });
      return Response.json({ ok: true, invite });
    }

    if (body.action === "revoke_invite") {
      if (!body.inviteId) return jsonError("inviteId required", 400);
      const invite = await revokeInvite({
        organisationId: org.id,
        inviteId: body.inviteId,
        revokedByUserId: session.userId,
      });
      return Response.json({ ok: true, invite });
    }

    const updated = await prisma.organisation.update({
      where: { id: org.id },
      data: {
        name: body.name ?? org.name,
        timezone: body.timezone ?? org.timezone,
        plan: body.plan ?? org.plan,
      },
    });
    await writeAuditLog({
      organisationId: org.id,
      userId: session.userId,
      action: "workspace.update",
      entityType: "Organisation",
      entityId: org.id,
      metadata: { name: updated.name, plan: updated.plan },
    });
    return Response.json({
      ok: true,
      workspace: {
        id: updated.id,
        name: updated.name,
        plan: updated.plan,
        timezone: updated.timezone,
      },
    });
  } catch (error) {
    if (error instanceof OnboardingError) {
      const status =
        error.code === "CONFLICT"
          ? 409
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "FORBIDDEN"
              ? 403
              : 400;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) {
      return jsonError(error.errors[0]?.message || "Invalid request", 400);
    }
    return jsonError(message, 500);
  }
}
