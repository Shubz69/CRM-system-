import { assertOrgExpensiveRouteAllowed, OrgRateLimitError } from "@/lib/org-rate-limit";
import { NextRequest } from "next/server";
import { ResearchJobKind, ResearchJobStatus } from "@prisma/client";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";

/**
 * GET /api/research — list ResearchJob rows with findings, sources, critic flags.
 * Never invents findings; empty when none exist.
 */
export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const jobs = await prisma.researchJob.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: {
        findings: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            source: {
              select: {
                id: true,
                url: true,
                title: true,
                platform: true,
                freshnessScore: true,
                publishedAt: true,
                retrievedAt: true,
              },
            },
          },
        },
        sources: {
          orderBy: { retrievedAt: "desc" },
          take: 20,
          select: {
            id: true,
            url: true,
            title: true,
            platform: true,
            freshnessScore: true,
            publishedAt: true,
            retrievedAt: true,
            author: true,
          },
        },
      },
    });

    const jobIds = jobs.map((j) => j.id);
    const assessments =
      jobIds.length === 0
        ? []
        : await prisma.qualityAssessment.findMany({
            where: {
              organisationId: session.organisationId,
              subjectKind: "ResearchJob",
              subjectId: { in: jobIds },
            },
            orderBy: { assessedAt: "desc" },
            take: 80,
            select: {
              id: true,
              subjectId: true,
              gateStatus: true,
              criticNotes: true,
              escalationReason: true,
              assessedAt: true,
              dimensions: true,
            },
          });

    const byJob = new Map<string, (typeof assessments)[number]>();
    for (const a of assessments) {
      if (!byJob.has(a.subjectId)) byJob.set(a.subjectId, a);
    }

    return Response.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        topic: job.topic,
        status: job.status,
        queries: job.queries,
        brief: job.brief,
        contradictions: job.contradictions,
        gaps: job.gaps,
        criticReport: job.criticReport,
        error: job.error,
        userFacingError: job.userFacingError,
        agentRunId: job.agentRunId,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        createdAt: job.createdAt,
        findings: job.findings.map((f) => ({
          id: f.id,
          claim: f.claim,
          evidenceExcerpt: f.evidenceExcerpt,
          confidence: f.confidence,
          claimKind: f.claimKind,
          freshnessScore: f.freshnessScore,
          verifiedByCritic: f.verifiedByCritic,
          flaggedUnsupported: f.flaggedUnsupported,
          flaggedUngrounded: f.flaggedUngrounded,
          source: f.source,
        })),
        sources: job.sources,
        qualityAssessment: byJob.get(job.id) ?? null,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const postSchema = z.object({
  action: z.enum(["create_draft"]).optional(),
  topic: z.string().min(3).max(2000),
  kind: z.nativeEnum(ResearchJobKind).optional(),
});

/**
 * POST /api/research — create a PENDING ResearchJob shell (no fake findings).
 * Full agent runs go through Ask; this only records a durable draft job.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("ask:use");
    assertOrgExpensiveRouteAllowed(session.organisationId, "research");
    const body = postSchema.parse(await req.json());

    const job = await prisma.researchJob.create({
      data: {
        organisationId: session.organisationId,
        kind: body.kind ?? ResearchJobKind.RESEARCH,
        topic: body.topic.trim(),
        status: ResearchJobStatus.PENDING,
        queries: [],
      },
    });

    return Response.json({
      jobId: job.id,
      status: job.status,
      message:
        "Research job created as PENDING with no findings yet. Run research via Ask to populate sources.",
    });
  } catch (error) {
    if (error instanceof OrgRateLimitError) {
      return Response.json({ error: error.message, code: error.code }, { status: 429 });
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 400);
  }
}
