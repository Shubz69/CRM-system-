import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Record a ToolCall for research adapters. Payloads stay modest — full source
 * bodies live on ResearchSource; retention still applies to these ToolCall rows.
 */
export async function recordResearchToolCall(input: {
  organisationId: string;
  agentStepId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  durationMs?: number;
}): Promise<string> {
  const row = await prisma.toolCall.create({
    data: {
      organisationId: input.organisationId,
      agentStepId: input.agentStepId,
      toolName: input.toolName,
      args: input.args as Prisma.InputJsonValue,
      result: (input.result ?? Prisma.DbNull) as Prisma.InputJsonValue,
      error: input.error ?? null,
      durationMs: input.durationMs ?? null,
    },
    select: { id: true },
  });
  return row.id;
}
