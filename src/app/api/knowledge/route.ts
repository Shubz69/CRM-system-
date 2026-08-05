import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { upsertKnowledgeDocument } from "@/services/knowledge";

export async function GET() {
  try {
    const session = await requirePermission("knowledge:manage");
    const documents = await prisma.knowledgeDocument.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { chunks: true, versions: true } } },
    });
    return Response.json({ documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const body = createSchema.parse(await req.json());
    const id = await upsertKnowledgeDocument({
      organisationId: session.organisationId,
      title: body.title,
      category: body.category,
      content: body.content,
      tags: body.tags,
    });
    return Response.json({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
