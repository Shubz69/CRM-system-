import { createHash } from "node:crypto";
import type { ToolTrustStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  ensureBuiltinToolsRegistered,
  listTools,
} from "@/kernel/tool-registry";
import type { ToolDefinition } from "@/kernel/types";

export type ToolTrustInput = {
  organisationId: string;
  tool: ToolDefinition;
  provider?: string;
  origin?: "first_party" | "mcp" | "external";
  status?: ToolTrustStatus;
  permissions?: string[];
  dataClasses?: string[];
  sideEffects?: string[];
  externalDestinations?: string[];
  approvalRequired?: boolean;
  allowedAgentTypes?: string[];
  verificationNote?: string;
};

function stableDefinition(def: ToolDefinition): string {
  return JSON.stringify({
    name: def.name.trim(),
    version: def.version.trim(),
    description: def.description.trim(),
    risk: def.risk,
  });
}

export function hashToolDefinition(def: ToolDefinition): string {
  return createHash("sha256").update(stableDefinition(def)).digest("hex");
}

export async function getToolTrust(organisationId: string, toolKey: string) {
  const organisationRecord = await prisma.toolTrustRecord.findUnique({
    where: { organisationId_toolKey: { organisationId, toolKey } },
  });
  if (organisationRecord) return organisationRecord;
  return prisma.toolTrustRecord.findUnique({
    where: { organisationId_toolKey: { organisationId: "global", toolKey } },
  });
}

export async function upsertToolTrust(input: ToolTrustInput) {
  const origin = input.origin ?? "first_party";
  const definitionHash = hashToolDefinition(input.tool);
  const existing = await prisma.toolTrustRecord.findUnique({
    where: {
      organisationId_toolKey: {
        organisationId: input.organisationId,
        toolKey: input.tool.name,
      },
    },
  });
  const changed = Boolean(existing && existing.definitionHash !== definitionHash);
  const quarantine = changed && origin !== "first_party";
  const status = quarantine ? "QUARANTINED" : (input.status ?? existing?.status ?? "TRUSTED");
  const verificationNote = quarantine
    ? `Definition hash changed for ${origin} tool; re-verification required`
    : (input.verificationNote ?? existing?.verificationNote ?? null);

  return prisma.toolTrustRecord.upsert({
    where: {
      organisationId_toolKey: {
        organisationId: input.organisationId,
        toolKey: input.tool.name,
      },
    },
    create: {
      organisationId: input.organisationId,
      toolKey: input.tool.name,
      provider: input.provider ?? "builtin",
      origin,
      version: input.tool.version,
      definitionHash,
      permissions: input.permissions ?? (input.tool.requiredPermission ? [input.tool.requiredPermission] : []),
      dataClasses: input.dataClasses ?? [],
      sideEffects: input.sideEffects ?? [],
      externalDestinations: input.externalDestinations ?? [],
      riskLevel: input.tool.risk,
      approvalRequired: input.approvalRequired ?? input.tool.risk !== "read",
      allowedAgentTypes: input.allowedAgentTypes ?? [],
      status,
      verificationNote,
      lastInspectionAt: new Date(),
    },
    update: {
      provider: input.provider ?? existing?.provider ?? "builtin",
      origin,
      version: input.tool.version,
      definitionHash,
      permissions: input.permissions ?? existing?.permissions,
      dataClasses: input.dataClasses ?? existing?.dataClasses,
      sideEffects: input.sideEffects ?? existing?.sideEffects,
      externalDestinations: input.externalDestinations ?? existing?.externalDestinations,
      riskLevel: input.tool.risk,
      approvalRequired: input.approvalRequired ?? existing?.approvalRequired,
      allowedAgentTypes: input.allowedAgentTypes ?? existing?.allowedAgentTypes,
      status,
      verificationNote,
      lastInspectionAt: new Date(),
    },
  });
}

export async function ensureBuiltinToolTrust() {
  ensureBuiltinToolsRegistered();
  return Promise.all(
    listTools().map((tool) =>
      upsertToolTrust({
        organisationId: "global",
        tool,
        provider: "builtin",
        origin: "first_party",
      }),
    ),
  );
}

function searchable(tool: ToolDefinition): string {
  return [
    tool.name,
    tool.description,
    tool.requiredPermission,
    ...(tool.platforms ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export async function shortlistTools(input: {
  organisationId: string;
  requiredCapabilities?: string[];
  missionObjective?: string;
  maxTools?: number;
  agentType?: string;
}): Promise<{
  available: ToolDefinition[];
  shortlisted: ToolDefinition[];
  rejected: Array<{ tool: ToolDefinition; reason: string }>;
}> {
  ensureBuiltinToolsRegistered();
  const tools = listTools();
  const records = await prisma.toolTrustRecord.findMany({
    where: {
      organisationId: { in: ["global", input.organisationId] },
      toolKey: { in: tools.map((tool) => tool.name) },
    },
  });
  const trust = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    if (record.organisationId === input.organisationId || !trust.has(record.toolKey)) {
      trust.set(record.toolKey, record);
    }
  }

  const available: ToolDefinition[] = [];
  const rejected: Array<{ tool: ToolDefinition; reason: string }> = [];
  for (const tool of tools) {
    const record = trust.get(tool.name);
    if (!record) {
      rejected.push({ tool, reason: "No inspected trust record" });
      continue;
    }
    if (record.status === "BLOCKED" || record.status === "QUARANTINED") {
      rejected.push({ tool, reason: `Trust status ${record.status}` });
      continue;
    }
    if (tool.risk === "destructive" || tool.risk === "admin") {
      rejected.push({ tool, reason: `Risk ${tool.risk} requires explicit approval` });
      continue;
    }
    if (
      input.agentType &&
      record.allowedAgentTypes.length > 0 &&
      !record.allowedAgentTypes.includes(input.agentType)
    ) {
      rejected.push({ tool, reason: `Not allowed for agent type ${input.agentType}` });
      continue;
    }
    available.push(tool);
  }

  const capabilities = (input.requiredCapabilities ?? []).map((value) => value.toLowerCase());
  const objectiveTerms = (input.missionObjective ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 3);
  const ranked = available
    .map((tool) => {
      const text = searchable(tool);
      const capabilityMatches = capabilities.filter((capability) => text.includes(capability)).length;
      const objectiveMatches = objectiveTerms.filter((term) => text.includes(term)).length;
      return { tool, score: capabilityMatches * 10 + objectiveMatches };
    })
    .filter(({ score }) => capabilities.length === 0 || score >= capabilities.length * 10)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  return {
    available,
    shortlisted: ranked.slice(0, Math.max(0, input.maxTools ?? 8)).map(({ tool }) => tool),
    rejected,
  };
}
