import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  getSocialConnectionPolicy,
  normalizeSocialConnectionPolicy,
  setSocialConnectionPolicy,
  SOCIAL_POLICY_NETWORKS,
} from "@/services/social-connection-policy";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  organisationId: z.string().min(1),
  socialConnectionsEnabled: z.boolean().optional(),
  maxConnectedSocialAccounts: z.number().int().min(0).nullable().optional(),
  allowedNetworks: z.array(z.enum(["INSTAGRAM", "LINKEDIN", "YOUTUBE"])).optional(),
});

/**
 * Platform-developer-only social connection quota controls.
 * Workspace users cannot raise their own limits.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePlatformAccess();
    const organisationId = req.nextUrl.searchParams.get("organisationId");
    if (!organisationId) return jsonError("organisationId required", 400);
    const org = await prisma.organisation.findFirst({
      where: { id: organisationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!org) return jsonError("Organisation not found", 404);
    const policy = await getSocialConnectionPolicy(organisationId);
    const profile = await prisma.zernioProfile.findUnique({
      where: { organisationId },
      select: { connectedAccounts: true },
    });
    const { countActiveConnectedAccounts } = await import("@/services/social-connection-policy");
    const accounts = Array.isArray(profile?.connectedAccounts)
      ? (profile!.connectedAccounts as Array<{ platform?: string; status?: string }>)
      : [];
    const connectedCount = countActiveConnectedAccounts(accounts);
    return Response.json({
      ok: true,
      organisationId: org.id,
      organisationName: org.name,
      policy,
      connectedCount,
      defaultsNote:
        "Orgs without a preference remain unlimited. New workspaces get maxConnectedSocialAccounts=2.",
      allowedNetworkOptions: SOCIAL_POLICY_NETWORKS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 400);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = patchSchema.parse(await req.json());
    const org = await prisma.organisation.findFirst({
      where: { id: body.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!org) return jsonError("Organisation not found", 404);

    const current = await getSocialConnectionPolicy(body.organisationId);
    const next = normalizeSocialConnectionPolicy({
      ...current,
      ...(body.socialConnectionsEnabled !== undefined
        ? { socialConnectionsEnabled: body.socialConnectionsEnabled }
        : {}),
      ...(body.maxConnectedSocialAccounts !== undefined
        ? { maxConnectedSocialAccounts: body.maxConnectedSocialAccounts }
        : {}),
      ...(body.allowedNetworks !== undefined ? { allowedNetworks: body.allowedNetworks } : {}),
    });
    const policy = await setSocialConnectionPolicy({
      organisationId: body.organisationId,
      policy: next,
      updatedByUserId: session.userId,
    });
    await writeAuditLog({
      organisationId: body.organisationId,
      userId: session.userId,
      action: "platform.social_connection_policy.update",
      entityType: "Organisation",
      entityId: body.organisationId,
      metadata: { policy },
    });
    return Response.json({ ok: true, policy });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 400);
  }
}
