import { NextRequest } from "next/server";
import { z } from "zod";
import { AlgorithmEvidenceKind } from "@prisma/client";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import { recordAlgorithmChange } from "@/services/trend-intelligence";

export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const changes = await prisma.algorithmChange.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { detectedAt: "desc" },
      take: 100,
    });
    return Response.json({ changes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  platform: z.string().min(1).max(40),
  surface: z.string().max(80).optional(),
  changeType: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).optional(),
  evidenceKind: z.nativeEnum(AlgorithmEvidenceKind),
  confidence: z.number().min(0).max(1).optional(),
  sourceUrl: z.string().url().optional(),
  affectedFormats: z.array(z.string().max(40)).max(20).optional(),
  expectedImpact: z.string().max(2000).optional(),
  recommendedExperiment: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = createSchema.parse(await req.json());
    const id = await recordAlgorithmChange({
      organisationId: session.organisationId,
      ...body,
      evidenceKind: body.evidenceKind,
    });
    return Response.json({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
