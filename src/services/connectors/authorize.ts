/**
 * Authorize connector tool execution before calling providers.
 */

import type { MemberRole } from "@prisma/client";
import { ensureBuiltinToolsRegistered, getTool } from "@/kernel/tool-registry";
import { evaluateToolPolicy } from "@/kernel/policy";
import { roleHasPermission, type Permission } from "@/lib/permissions";
import { getConnectorDefinition } from "@/services/connectors/catalogue";
import {
  assertCircuitClosed,
  assertNotRateLimited,
} from "@/services/connectors/resilience";
import { prisma } from "@/lib/db";
import { ConnectorCapabilityStatus } from "@prisma/client";

export class ConnectorAuthzError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConnectorAuthzError";
  }
}

export async function authorizeConnectorTool(input: {
  organisationId: string;
  toolName: string;
  providerKey: string;
  capability: string;
  connectionRef?: string | null;
  userId?: string;
  role?: MemberRole;
  isPlatformAdmin?: boolean;
  operationClass?: string;
}): Promise<{ effect: "allow" | "require_approval"; reason: string }> {
  ensureBuiltinToolsRegistered();
  const tool = getTool(input.toolName);
  if (!tool) {
    throw new ConnectorAuthzError("TOOL_UNKNOWN", `Unknown tool ${input.toolName}`);
  }

  if (tool.requiredPermission && input.role) {
    if (
      !input.isPlatformAdmin &&
      !roleHasPermission(input.role, tool.requiredPermission as Permission)
    ) {
      throw new ConnectorAuthzError(
        "PERMISSION_DENIED",
        `Missing permission ${tool.requiredPermission}`,
      );
    }
  }

  const policy = evaluateToolPolicy(input.toolName, {
    organisationId: input.organisationId,
    userId: input.userId,
    role: input.role,
    isPlatformAdmin: input.isPlatformAdmin,
  });
  if (policy.effect === "deny") {
    throw new ConnectorAuthzError("POLICY_DENY", policy.reason);
  }

  const def = getConnectorDefinition(input.providerKey);
  if (!def) {
    throw new ConnectorAuthzError("PROVIDER_UNKNOWN", `Unknown provider ${input.providerKey}`);
  }

  const cap = await prisma.connectorCapabilityState.findFirst({
    where: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      capability: input.capability,
      ...(input.connectionRef
        ? { connectionRef: input.connectionRef }
        : {}),
    },
  });
  if (
    cap &&
    (cap.status === ConnectorCapabilityStatus.UNSUPPORTED ||
      cap.status === ConnectorCapabilityStatus.DISABLED ||
      cap.status === ConnectorCapabilityStatus.AUTH_REQUIRED ||
      cap.status === ConnectorCapabilityStatus.SCOPE_REQUIRED ||
      cap.status === ConnectorCapabilityStatus.RESTRICTED)
  ) {
    throw new ConnectorAuthzError(
      "CAPABILITY_UNAVAILABLE",
      `Capability ${input.capability} status=${cap.status} (${cap.provenance})`,
    );
  }

  await assertNotRateLimited({
    organisationId: input.organisationId,
    providerKey: input.providerKey,
    connectionRef: input.connectionRef,
    operationClass: input.operationClass,
  });
  await assertCircuitClosed({
    organisationId: input.organisationId,
    providerKey: input.providerKey,
    connectionRef: input.connectionRef,
    operationClass: input.operationClass,
  });

  return {
    effect: policy.effect === "require_approval" ? "require_approval" : "allow",
    reason: policy.reason,
  };
}
