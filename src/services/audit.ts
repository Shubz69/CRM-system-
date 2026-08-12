import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getPlatformOrganisationId } from "@/lib/platform-org";

export async function writeAuditLog(input: {
  organisationId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const organisationId = input.organisationId || (await getPlatformOrganisationId());
  await prisma.auditLog.create({
    data: {
      organisationId,
      userId: input.userId ?? undefined,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: JSON.parse(JSON.stringify(input.metadata ?? {})) as Prisma.InputJsonValue,
    },
  });
}
