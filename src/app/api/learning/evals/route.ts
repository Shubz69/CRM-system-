import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { ensureDefaultEvalSuite, runEvalSuite } from "@/services/learning-os";

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    await ensureDefaultEvalSuite(session.organisationId);
    const [suites, runs] = await Promise.all([
      prisma.evalSuite.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.evalRun.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return Response.json({ suites, runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const runSchema = z.object({
  suiteKey: z.string().optional(),
  candidateId: z.string().optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = runSchema.parse(await req.json().catch(() => ({})));
    const evalRun = await runEvalSuite({
      organisationId: session.organisationId,
      suiteKey: body.suiteKey,
      candidateId: body.candidateId,
    });
    return Response.json({ evalRun });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
