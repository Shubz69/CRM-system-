import type { AutopilotMode, Organisation, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  parseAutopilotConfig,
  type AutopilotCapability,
  type AutopilotCapabilityMode,
  type AutopilotConfig,
} from "@/lib/autopilot-config";
import { writeAuditLog, tenantAuditLogWhere } from "@/services/audit";

export type { AutopilotCapability, AutopilotCapabilityMode, AutopilotConfig };
export { DEFAULT_AUTOPILOT_CONFIG, parseAutopilotConfig };

export function isAutopilotOperating(
  mode: AutopilotMode,
  options?: { provider?: string },
): boolean {
  if (mode === "LIVE") return true;
  if (mode === "TEST") {
    const provider = options?.provider ?? "";
    return provider === "simulator" || provider === "test";
  }
  return false;
}

export function capabilityAllowsAuto(
  config: AutopilotConfig,
  capability: AutopilotCapability,
): boolean {
  return config[capability] === "automatic";
}

export function capabilityRequiresApproval(
  config: AutopilotConfig,
  capability: AutopilotCapability,
): boolean {
  return config[capability] === "approval_required";
}

export async function getOrganisationAutopilot(organisationId: string) {
  const org = await prisma.organisation.findFirst({
    where: { id: organisationId, deletedAt: null },
    select: {
      id: true,
      status: true,
      autopilotMode: true,
      autopilotConfig: true,
      name: true,
    },
  });
  if (!org) return null;
  return {
    ...org,
    config: parseAutopilotConfig(org.autopilotConfig),
  };
}

export async function setAutopilotMode(input: {
  organisationId: string;
  userId: string;
  mode: AutopilotMode;
  config?: Partial<AutopilotConfig>;
  reason?: string;
}) {
  const current = await getOrganisationAutopilot(input.organisationId);
  if (!current) throw new Error("Organisation not found");
  if (current.status === "SUSPENDED") {
    throw new Error("Workspace is suspended");
  }

  const nextConfig = {
    ...current.config,
    ...(input.config || {}),
  };

  const updated = await prisma.organisation.update({
    where: { id: input.organisationId },
    data: {
      autopilotMode: input.mode,
      autopilotConfig: nextConfig as Prisma.InputJsonValue,
      lastActivityAt: new Date(),
    },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId,
    action: "autopilot.mode_change",
    entityType: "Organisation",
    entityId: input.organisationId,
    metadata: {
      from: current.autopilotMode,
      to: input.mode,
      reason: input.reason,
      config: nextConfig,
    },
  });

  return {
    mode: updated.autopilotMode,
    config: parseAutopilotConfig(updated.autopilotConfig),
  };
}

export async function getAutopilotTodayStats(organisationId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [
    handledToday,
    qualifiedToday,
    bookingsToday,
    aiActive,
    waitingHuman,
    attentionErrors,
    recentActivity,
  ] = await Promise.all([
    prisma.message.count({
      where: {
        organisationId,
        senderType: "AI",
        createdAt: { gte: start },
      },
    }),
    prisma.lead.count({
      where: {
        organisationId,
        deletedAt: null,
        qualificationStatus: "QUALIFIED",
        updatedAt: { gte: start },
      },
    }),
    prisma.booking.count({
      where: {
        organisationId,
        createdAt: { gte: start },
        status: { in: ["CREATED", "ATTENDED", "OFFERED", "RESCHEDULED"] },
      },
    }),
    prisma.conversation.count({
      where: {
        organisationId,
        deletedAt: null,
        handlingMode: "AI",
        aiPaused: false,
      },
    }),
    prisma.conversation.count({
      where: {
        organisationId,
        deletedAt: null,
        OR: [{ needsHumanReview: true }, { handlingMode: "HUMAN" }],
      },
    }),
    prisma.notification.count({
      where: {
        organisationId,
        type: { in: ["AI_FAILURE", "FOLLOW_UP_FAILURE", "AUTOMATION_FAILURE", "SYSTEM"] },
        readAt: null,
        createdAt: { gte: start },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        ...tenantAuditLogWhere(organisationId),
        action: {
          in: [
            "autopilot.mode_change",
            "lead.qualified",
            "lead.stage_change",
            "booking.offered",
            "booking.created",
            "conversation.handover",
            "knowledge.gap",
          ],
        },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  return {
    handledToday,
    qualifiedToday,
    bookingsToday,
    aiActive,
    waitingHuman,
    attentionErrors,
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export type OrgAutopilot = Pick<
  Organisation,
  "id" | "status" | "autopilotMode" | "autopilotConfig" | "name"
> & { config: AutopilotConfig };
