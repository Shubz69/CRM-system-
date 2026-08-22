import { NextRequest } from "next/server";
import { z } from "zod";
import { KnowledgeDocStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { upsertKnowledgeDocument, chunkText, updateKnowledgeDocument, archiveKnowledgeDocument } from "@/services/knowledge";
import { assertKnowledgePromotionPolicy } from "@/services/agent-memory";

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
  status: z.nativeEnum(KnowledgeDocStatus).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const title = String(form.get("title") || "Uploaded document");
      const category = String(form.get("category") || "upload");
      const file = form.get("file");
      if (!(file instanceof File)) return jsonError("file is required", 400);
      if (file.size > 5 * 1024 * 1024) return jsonError("File too large (max 5MB)", 400);

      const mime = file.type || "application/octet-stream";
      const buffer = Buffer.from(await file.arrayBuffer());
      let text = "";

      if (mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        // Lightweight text extraction: reject clearly binary/encrypted PDFs without extractable text
        const raw = buffer.toString("latin1");
        if (raw.includes("/Encrypt")) {
          return jsonError("Encrypted PDFs are not supported. Upload an unencrypted text PDF.", 400);
        }
        const matches = raw.match(/\((?:\\.|[^\\)]){3,}\)/g) || [];
        text = matches
          .map((m) => m.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"))
          .join("\n")
          .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g, " ")
          .trim();
        if (text.length < 40) {
          return jsonError(
            "Could not extract enough text. Image-only PDFs are not supported. Paste text or upload a text-based PDF.",
            400,
          );
        }
      } else if (mime.startsWith("text/") || file.name.match(/\.(md|txt|markdown)$/i)) {
        text = buffer.toString("utf8");
      } else {
        return jsonError("Unsupported file type. Use PDF, Markdown, or plain text.", 400);
      }

      const id = await upsertKnowledgeDocument({
        organisationId: session.organisationId,
        title,
        category,
        content: text,
        tags: ["upload"],
      });
      return Response.json({ id, extractedChars: text.length });
    }

    const body = createSchema.parse(await req.json());
    const promotion = assertKnowledgePromotionPolicy({
      category: body.category,
      tags: body.tags,
      status: body.status ?? null,
    });
    if (!promotion.ok) return jsonError(promotion.error, 400);

    const id = await upsertKnowledgeDocument({
      organisationId: session.organisationId,
      title: body.title,
      category: body.category,
      content: body.content,
      tags: body.tags,
    });

    const status = promotion.forcedStatus
      ? KnowledgeDocStatus.INACTIVE
      : body.status;
    if (status) {
      await prisma.knowledgeDocument.update({
        where: { id },
        data: { status },
      });
    }

    return Response.json({ id, chunks: chunkText(body.content).length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

const patchSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  category: z.string().optional(),
  content: z.string().optional(),
  status: z.nativeEnum(KnowledgeDocStatus).optional(),
  tags: z.array(z.string()).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const body = patchSchema.parse(await req.json());
    const existing = await prisma.knowledgeDocument.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });
    if (!existing) return jsonError("Document not found", 404);

    if (body.content && body.content !== existing.content) {
      await updateKnowledgeDocument({
        id: existing.id,
        organisationId: session.organisationId,
        title: body.title,
        category: body.category,
        content: body.content,
        tags: body.tags,
        status: body.status,
      });
    } else {
      await prisma.knowledgeDocument.update({
        where: { id: existing.id },
        data: {
          title: body.title,
          category: body.category,
          status: body.status,
          tags: body.tags,
        },
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return jsonError("id is required", 400);
    await archiveKnowledgeDocument({ id, organisationId: session.organisationId });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message === "Document not found") return jsonError(message, 404);
    return jsonError(message, 500);
  }
}
