import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  getOnboardingProgress,
  setOnboardingProgress,
  type OnboardingProgress,
} from "@/services/beta-workspace";
import {
  upsertBusinessClaim,
  upsertAudienceSegmentByName,
  upsertProductOfferingByName,
} from "@/services/digital-twin";
import { writeAuditLog } from "@/services/audit";
import { prisma } from "@/lib/db";

const PRIMARY_OFFERING = "Primary offering";
const PRIMARY_AUDIENCE = "Primary audience";

/**
 * What the workspace has saved today for each onboarding answer, so re-entering onboarding
 * pre-fills the live values (brand tone edited in AI Agent, offering edited in Business
 * profile, …) instead of the onboarding defaults — Continue must never overwrite them.
 */
async function loadSavedAnswers(organisationId: string): Promise<{
  businessName: string | null;
  whatYouDo: string | null;
  whoToReach: string | null;
  agentBehaviour: string | null;
}> {
  const [org, offering, audience, agent] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: organisationId }, select: { name: true } }),
    prisma.productOffering.findFirst({
      where: { organisationId, name: PRIMARY_OFFERING },
      orderBy: { createdAt: "asc" },
      select: { description: true },
    }),
    prisma.audienceSegment.findFirst({
      where: { organisationId, name: PRIMARY_AUDIENCE },
      orderBy: { createdAt: "asc" },
      select: { description: true },
    }),
    prisma.agentConfiguration.findFirst({
      where: { organisationId, isActive: true },
      orderBy: { updatedAt: "desc" },
      select: { brandTone: true },
    }),
  ]);
  const text = (value: string | null | undefined) => value?.trim() || null;
  return {
    businessName: text(org?.name),
    whatYouDo: text(offering?.description),
    whoToReach: text(audience?.description),
    agentBehaviour: text(agent?.brandTone),
  };
}

export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const progress = await getOnboardingProgress(session.organisationId);
    const saved = await loadSavedAnswers(session.organisationId).catch(() => null);
    const policy = await import("@/services/social-connection-policy").then((m) =>
      m.getSocialConnectionPolicy(session.organisationId),
    );
    return Response.json({
      progress,
      saved,
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
    // Skipping connections is the last step — the UI tells the user they're done, so it completes too.
    const finishing = body.action === "complete" || body.action === "skip_connections";

    // Only answers actually sent with a value are written. A blank or missing answer never
    // overwrites what is saved (re-entering onboarding used to reset the brand tone to the
    // default text on Continue, because every save rewrote every field).
    const provided = (value: string | undefined) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    };
    const businessName = provided(body.progress?.businessName);
    const whatYouDo = provided(body.progress?.whatYouDo);
    const whoToReach = provided(body.progress?.whoToReach);
    const agentBehaviour = provided(body.progress?.agentBehaviour);

    const next: OnboardingProgress = {
      ...existing,
      ...(body.progress?.currentStep !== undefined ? { currentStep: body.progress.currentStep } : {}),
      ...(businessName ? { businessName } : {}),
      ...(whatYouDo ? { whatYouDo } : {}),
      ...(whoToReach ? { whoToReach } : {}),
      ...(agentBehaviour ? { agentBehaviour } : {}),
      completed: finishing ? true : existing.completed,
      skippedConnections:
        body.action === "skip_connections"
          ? true
          : body.progress?.skippedConnections ?? existing.skippedConnections,
      completedAt: finishing ? new Date().toISOString() : existing.completedAt,
    };

    // Feed existing org/business context architecture (org-scoped only).
    if (businessName) {
      await prisma.organisation.update({
        where: { id: session.organisationId },
        data: { name: businessName },
      }).catch(() => undefined);
      await upsertBusinessClaim({
        organisationId: session.organisationId,
        subjectType: "Organisation",
        subjectId: session.organisationId,
        predicate: "business_name",
        valueText: businessName,
        source: "onboarding",
        confidence: 0.9,
      }).catch(() => undefined);
    }
    if (whatYouDo) {
      await upsertProductOfferingByName({
        organisationId: session.organisationId,
        name: PRIMARY_OFFERING,
        description: whatYouDo,
      }).catch(() => undefined);
      await upsertBusinessClaim({
        organisationId: session.organisationId,
        subjectType: "Organisation",
        subjectId: session.organisationId,
        predicate: "what_we_do",
        valueText: whatYouDo,
        source: "onboarding",
        confidence: 0.85,
      }).catch(() => undefined);
    }
    if (whoToReach) {
      await upsertAudienceSegmentByName({
        organisationId: session.organisationId,
        name: PRIMARY_AUDIENCE,
        description: whoToReach,
      }).catch(() => undefined);
    }
    if (agentBehaviour) {
      await prisma.agentConfiguration.updateMany({
        where: { organisationId: session.organisationId, isActive: true },
        data: { brandTone: agentBehaviour.slice(0, 500) },
      }).catch(() => undefined);
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
