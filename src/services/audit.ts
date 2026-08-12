import type { AuditLogScope, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type OrgAuditLogInput = {
  scope?: "ORG";
  organisationId: string;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
};

export type PlatformAuditLogInput = {
  scope: "PLATFORM";
  organisationId?: null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
};

export type WriteAuditLogInput = OrgAuditLogInput | PlatformAuditLogInput;

/** Tenant-facing AuditLog filter — never returns PLATFORM rows. */
export function tenantAuditLogWhere(organisationId: string): Prisma.AuditLogWhereInput {
  return {
    scope: "ORG",
    organisationId,
  };
}

/**
 * Write an audit row with explicit scope.
 * - ORG (default): organisationId required
 * - PLATFORM: organisationId must be null
 */
export async function writeAuditLog(input: WriteAuditLogInput): Promise<void> {
  const scope: AuditLogScope = input.scope === "PLATFORM" ? "PLATFORM" : "ORG";

  if (scope === "ORG") {
    if (!("organisationId" in input) || !input.organisationId) {
      throw new Error("ORG-scoped AuditLog requires organisationId");
    }
    await prisma.auditLog.create({
      data: {
        scope: "ORG",
        organisationId: input.organisationId,
        userId: input.userId ?? undefined,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: JSON.parse(JSON.stringify(input.metadata ?? {})) as Prisma.InputJsonValue,
      },
    });
    return;
  }

  if (input.organisationId) {
    throw new Error("PLATFORM-scoped AuditLog must not set organisationId");
  }

  await prisma.auditLog.create({
    data: {
      scope: "PLATFORM",
      organisationId: null,
      userId: input.userId ?? undefined,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: JSON.parse(JSON.stringify(input.metadata ?? {})) as Prisma.InputJsonValue,
    },
  });
}
