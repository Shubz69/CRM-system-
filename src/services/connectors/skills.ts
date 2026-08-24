/**
 * Skill registry — versioned reusable business capabilities (not customer code).
 */

import { SkillDefinitionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureBuiltinToolsRegistered, getTool } from "@/kernel/tool-registry";

export type BuiltinSkillSeed = {
  key: string;
  version: string;
  name: string;
  description: string;
  requiredTools: string[];
  optionalTools?: string[];
  allowedAgents?: string[];
  risk?: string;
};

export const BUILTIN_SKILLS: BuiltinSkillSeed[] = [
  {
    key: "research-web",
    version: "1.0.0",
    name: "Research web",
    description: "Search the public web via configured research providers.",
    requiredTools: ["sources.search"],
    risk: "read",
  },
  {
    key: "research-social",
    version: "1.0.0",
    name: "Research social",
    description: "Search licensed social sources (Apify / configured platforms).",
    requiredTools: ["sources.search"],
    risk: "read",
  },
  {
    key: "qualify-lead",
    version: "1.0.0",
    name: "Qualify lead",
    description: "Read conversation context to support lead qualification.",
    requiredTools: ["crm.read_conversation"],
    optionalTools: ["knowledge.retrieve"],
    risk: "read",
  },
  {
    key: "draft-followup",
    version: "1.0.0",
    name: "Draft follow-up",
    description: "Prepare a follow-up message (send still requires messaging.send + approval).",
    requiredTools: ["crm.read_conversation"],
    optionalTools: ["messaging.send"],
    risk: "write_internal",
  },
  {
    key: "publish-social",
    version: "1.0.0",
    name: "Publish social",
    description: "Request social publish via policy-gated social.publish (Phase 15 completes E2E).",
    requiredTools: ["social.publish"],
    risk: "publish",
  },
  {
    key: "analyse-performance",
    version: "1.0.0",
    name: "Analyse performance",
    description: "Refresh trends and retrieve knowledge for performance analysis.",
    requiredTools: ["trends.refresh"],
    optionalTools: ["knowledge.retrieve"],
    risk: "read",
  },
];

export async function ensureBuiltinSkillsSeeded(): Promise<number> {
  ensureBuiltinToolsRegistered();
  let n = 0;
  for (const skill of BUILTIN_SKILLS) {
    const existing = await prisma.skillDefinition.findFirst({
      where: { organisationId: null, key: skill.key, version: skill.version },
    });
    if (existing) continue;
    await prisma.skillDefinition.create({
      data: {
        organisationId: null,
        key: skill.key,
        version: skill.version,
        name: skill.name,
        description: skill.description,
        requiredTools: skill.requiredTools,
        optionalTools: skill.optionalTools ?? [],
        allowedAgents: skill.allowedAgents ?? [],
        risk: skill.risk ?? "read",
        status: SkillDefinitionStatus.ACTIVE,
        inputSchema: {} as Prisma.InputJsonValue,
        outputSchema: {} as Prisma.InputJsonValue,
      },
    });
    n += 1;
  }
  return n;
}

export async function resolveSkill(input: {
  organisationId: string;
  key: string;
  version?: string;
}) {
  if (input.version) {
    const exact =
      (await prisma.skillDefinition.findFirst({
        where: {
          key: input.key,
          version: input.version,
          status: SkillDefinitionStatus.ACTIVE,
          OR: [{ organisationId: input.organisationId }, { organisationId: null }],
        },
        orderBy: { organisationId: "desc" },
      })) ?? null;
    return exact;
  }
  return prisma.skillDefinition.findFirst({
    where: {
      key: input.key,
      status: SkillDefinitionStatus.ACTIVE,
      OR: [{ organisationId: input.organisationId }, { organisationId: null }],
    },
    orderBy: [{ organisationId: "desc" }, { version: "desc" }],
  });
}

export async function assertSkillExecutable(input: {
  organisationId: string;
  key: string;
  version?: string;
  agentType?: string;
}) {
  ensureBuiltinToolsRegistered();
  const skill = await resolveSkill(input);
  if (!skill) throw new Error(`Skill not found: ${input.key}`);
  if (skill.allowedAgents.length && input.agentType) {
    if (!skill.allowedAgents.includes(input.agentType)) {
      throw new Error(`Skill ${skill.key} not allowed for agent ${input.agentType}`);
    }
  }
  for (const toolName of skill.requiredTools) {
    if (!getTool(toolName)) {
      throw new Error(`Skill ${skill.key} missing required tool ${toolName}`);
    }
  }
  return skill;
}

export async function recordSkillExecution(input: {
  organisationId: string;
  skillDefinitionId: string;
  skillKey: string;
  skillVersion: string;
  agentRunId?: string;
  missionId?: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
}) {
  return prisma.skillExecution.create({
    data: {
      organisationId: input.organisationId,
      skillDefinitionId: input.skillDefinitionId,
      skillKey: input.skillKey,
      skillVersion: input.skillVersion,
      agentRunId: input.agentRunId,
      missionId: input.missionId,
      status: input.status ?? "COMPLETED",
      inputSummary: input.inputSummary,
      outputSummary: input.outputSummary,
    },
  });
}

export async function listSkillsForOrg(organisationId: string) {
  await ensureBuiltinSkillsSeeded();
  return prisma.skillDefinition.findMany({
    where: {
      status: { in: [SkillDefinitionStatus.ACTIVE, SkillDefinitionStatus.DEPRECATED] },
      OR: [{ organisationId }, { organisationId: null }],
    },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
}
