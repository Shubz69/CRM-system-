import { NextRequest } from "next/server";
import { z } from "zod";
import { KnowledgeDocStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, requirePermissionForMutation, jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
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

/**
 * Ask/research drafts are all titled "Research draft — <date>" by the client, and
 * upsertKnowledgeDocument matches on title — so a second draft the same day overwrote the first.
 * Give each distinct draft its own title ("… (2)", "… (3)"); re-saving identical content returns
 * the existing draft untouched instead of duplicating it.
 */
async function distinctDraftTitle(
  organisationId: string,
  title: string,
  content: string,
): Promise<{ title: string; existingId?: string }> {
  const siblings = await prisma.knowledgeDocument.findMany({
    where: { organisationId, title: { startsWith: title } },
    select: { id: true, title: true, content: true },
  });
  if (!siblings.length) return { title };
  const isSameTitle = (candidate: string) =>
    candidate === title ||
    (candidate.startsWith(`${title} (`) && /^\d+\)$/.test(candidate.slice(title.length + 2)));
  const sameTitle = siblings.filter((d) => isSameTitle(d.title));
  const identical = sameTitle.find((d) => d.content === content);
  if (identical) return { title: identical.title, existingId: identical.id };
  const taken = new Set(sameTitle.map((d) => d.title));
  if (!taken.has(title)) return { title };
  let n = 2;
  while (taken.has(`${title} (${n})`)) n += 1;
  return { title: `${title} (${n})` };
}

/**
 * upsertKnowledgeDocument matches on title and overwrites (and reactivates) whatever it finds,
 * so a plain "Add" with a title that is already taken silently replaced someone's document.
 * Adding now refuses with 409 unless the client explicitly asks to replace that document
 * (`replaceExisting: true`); editing goes through PATCH by id.
 */
/** Titles are compared trimmed, with runs of spaces collapsed, and ignoring case. */
function normaliseTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

async function findTitleClash(organisationId: string, title: string) {
  return prisma.knowledgeDocument.findFirst({
    where: { organisationId, title: { equals: normaliseTitle(title), mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, status: true },
  });
}

function duplicateTitleResponse(existing: { id: string; title: string; status: string }) {
  return Response.json(
    {
      error: `A document called "${existing.title}" already exists — open it to edit, or choose another title.`,
      code: "DUPLICATE_TITLE",
      existingId: existing.id,
      existingStatus: existing.status,
    },
    { status: 409 },
  );
}

const createSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  status: z.nativeEnum(KnowledgeDocStatus).optional(),
  /** Explicit opt-in to overwrite the document that already has this title. */
  replaceExisting: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    const session = await requirePermissionForMutation("knowledge:manage", req, null);

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      let title = normaliseTitle(String(form.get("title") || "")) || "Uploaded document";
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

      const uploadClash = await findTitleClash(session.organisationId, title);
      if (uploadClash) {
        if (String(form.get("replaceExisting") || "") !== "true") {
          return duplicateTitleResponse(uploadClash);
        }
        // Replace that exact document (the save below matches on its stored title).
        title = uploadClash.title;
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

    let title = normaliseTitle(body.title);
    if (!title) return jsonError("Give the document a title.", 400);
    if ((body.tags ?? []).includes("from-ask")) {
      const draft = await distinctDraftTitle(session.organisationId, body.title, body.content);
      if (draft.existingId) {
        return Response.json({ id: draft.existingId, chunks: chunkText(body.content).length });
      }
      title = draft.title;
    } else {
      const clash = await findTitleClash(session.organisationId, title);
      if (clash && !body.replaceExisting) return duplicateTitleResponse(clash);
      // Replace that exact document (the save below matches on its stored title).
      if (clash) title = clash.title;
    }

    const id = await upsertKnowledgeDocument({
      organisationId: session.organisationId,
      title,
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
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
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
    const raw = await req.json();
    const session = await requirePermissionForMutation("knowledge:manage", req, raw);
    const body = patchSchema.parse(raw);
    const existing = await prisma.knowledgeDocument.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });
    if (!existing) return jsonError("Document not found", 404);

    // Renaming onto another document's title (in any case or spacing) would make the next
    // title-matched save hit the wrong doc.
    if (body.title !== undefined) {
      body.title = normaliseTitle(body.title);
      if (!body.title) return jsonError("Give the document a title.", 400);
    }
    if (body.title && body.title !== existing.title) {
      const clash = await findTitleClash(session.organisationId, body.title);
      if (clash && clash.id !== existing.id) return duplicateTitleResponse(clash);
    }

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
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requirePermissionForMutation("knowledge:manage", req, null);
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return jsonError("id is required", 400);
    await archiveKnowledgeDocument({ id, organisationId: session.organisationId });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message === "Document not found") return jsonError(message, 404);
    return jsonError(message, 500);
  }
}
