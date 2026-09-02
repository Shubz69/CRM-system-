import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  getOnboardingProgress,
  setOnboardingProgress,
  type OnboardingProgress,
} from "@/services/beta-workspace";
import { upsertBusinessClaim, createAudienceSegment, createProductOffering } from "@/services/digital-twin";
import { writeAuditLog } from "@/services/audit";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const progress = await getOnboardingProgress(session.organisationId);
    const policy = await import("@/services/social-connection-policy").then((m) =>
      m.getSocialConnectionPolicy(session.organisationId),
    );
    return Response.json({
      progress,
      socialPolicy: {
        enabled: policy.socialConnectionsEnabled,
        max: policy.maxConnectedSocialAccounts,
        networks: policy.allowedNetworks,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const saveSchema = z.object({
  action: z.enum(["save_progress", "complete", "skip_connections"]),
  progress: z
    .object({
      currentStep: z.number().int().min(0).max(5).optional(),
      businessName: z.string().max(200).optional(),
      whatYouDo: z.string().max(2000).optional(),
      whoToReach: z.string().max(2000).optional(),
      agentBehaviour: z.string().max(2000).optional(),
      skippedConnections: z.boolean().optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = saveSchema.parse(await req.json());
    const existing = await getOnboardingProgress(session.organisationId);

    const next: OnboardingProgress = {
      ...existing,
      ...(body.progress || {}),
      completed: body.action === "complete" ? true : existing.completed,
      skippedConnections:
        body.action === "skip_connections"
          ? true
          : body.progress?.skippedConnections ?? existing.skippedConnections,
      completedAt:
        body.action === "complete" ? new Date().toISOString() : existing.completedAt,
    };

    if (body.action === "complete" || body.action === "save_progress") {
      // Feed existing org/business context architecture (org-scoped only).
      if (next.businessName?.trim()) {
        await prisma.organisation.update({
          where: { id: session.organisationId },
          data: { name: next.businessName.trim() },
        }).catch(() => undefined);
        await upsertBusinessClaim({
          organisationId: session.organisationId,
          subjectType: "Organisation",
          subjectId: session.organisationId,
          predicate: "business_name",
          valueText: next.businessName.trim(),
          source: "onboarding",
          confidence: 0.9,
        }).catch(() => undefined);
      }
      if (next.whatYouDo?.trim()) {
        await createProductOffering({
          organisationId: session.organisationId,
          name: "Primary offering",
          description: next.whatYouDo.trim(),
        }).catch(() => undefined);
        await upsertBusinessClaim({
          organisationId: session.organisationId,
          subjectType: "Organisation",
          subjectId: session.organisationId,
          predicate: "what_we_do",
          valueText: next.whatYouDo.trim(),
          source: "onboarding",
          confidence: 0.85,
        }).catch(() => undefined);
      }
      if (next.whoToReach?.trim()) {
        await createAudienceSegment({
          organisationId: session.organisationId,
          name: "Primary audience",
          description: next.whoToReach.trim(),
        }).catch(() => undefined);
      }
      if (next.agentBehaviour?.trim()) {
        await prisma.agentConfiguration.updateMany({
          where: { organisationId: session.organisationId, isActive: true },
          data: { brandTone: next.agentBehaviour.trim().slice(0, 500) },
        }).catch(() => undefined);
      }
    }

    await setOnboardingProgress({
      organisationId: session.organisationId,
      progress: next,
      updatedByUserId: session.userId,
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: `workspace.onboarding.${body.action}`,
      entityType: "Organisation",
      entityId: session.organisationId,
      metadata: { step: next.currentStep, completed: next.completed },
    });

    return Response.json({ ok: true, progress: next });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(error.errors[0]?.message || "Invalid request", 400);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
