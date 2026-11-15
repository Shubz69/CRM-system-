import { Prisma } from "@prisma/client";
import { z } from "zod";
import { readableZodError } from "@/lib/readable-zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

const fieldSchema = z.object({
  id: z.string().optional(),
  key: z.string().trim().min(1, "Key is required.").max(100, "Key must be 100 characters or fewer.").optional(),
  label: z.string().trim().min(1, "Label is required.").max(200, "Label must be 200 characters or fewer.").optional(),
  fieldType: z.string().trim().min(1).max(50).optional(),
  required: z.boolean().optional(),
  weight: z.number().int().min(0).max(100).optional(),
  position: z.number().int().min(0).optional(),
  options: z.array(z.string()).optional(),
  disqualifyingAnswers: z.array(z.string()).optional(),
});

// Editing can also switch a deactivated field back on (DELETE only deactivates).
const editSchema = fieldSchema.extend({ id: z.string().min(1), active: z.boolean().optional() });

const FIELD_LABELS: Record<string, string> = {
  key: "Key",
  label: "Label",
  fieldType: "Field type",
  required: "Required",
  weight: "Weight",
  position: "Position",
  options: "Options",
  disqualifyingAnswers: "Disqualifying answers",
  id: "Field id",
  active: "Active",
};

/** One readable sentence from a zod error — never the raw issue JSON or zod's own wording. */
function readableValidationError(error: z.ZodError): string {
  return readableZodError(error, FIELD_LABELS, "Check the qualification field and try again.");
}

function duplicateKeyMessage(key: string, inactive: boolean): string {
  return inactive
    ? `A deactivated field already uses the key "${key}". Reactivate it from the list instead, or choose a different key.`
    : `A field with the key "${key}" already exists. Choose a different key.`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Map an error to a response. Prisma/zod/internal text never reaches the client. */
function errorResponse(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) return jsonError(readableValidationError(error), 400);
  if (error instanceof SyntaxError) return jsonError("Invalid request body", 400);
  const message = error instanceof Error ? error.message : "";
  if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
  if (message.startsWith("Forbidden")) {
    return jsonError("You don't have permission to manage qualification fields.", 403);
  }
  return jsonError(fallback, 500);
}

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const fields = await prisma.qualificationField.findMany({ where: { organisationId: session.organisationId }, orderBy: { position: "asc" } });
    return Response.json({ fields });
  } catch (error) {
    return errorResponse(error, "Couldn't load qualification fields. Try again.");
  }
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = fieldSchema.required({ key: true, label: true }).parse(await req.json());
    const clash = await prisma.qualificationField.findFirst({
      where: { organisationId: session.organisationId, key: body.key },
      select: { id: true, active: true },
    });
    if (clash) {
      return Response.json(
        {
          error: duplicateKeyMessage(body.key, !clash.active),
          code: "DUPLICATE_KEY",
          existingFieldId: clash.id,
          existingFieldActive: clash.active,
        },
        { status: 409 },
      );
    }
    try {
      const field = await prisma.qualificationField.create({ data: { organisationId: session.organisationId, key: body.key, label: body.label, fieldType: body.fieldType ?? "short_text", required: body.required ?? false, weight: body.weight ?? 10, position: body.position ?? 0, options: body.options ?? [], disqualifyingAnswers: body.disqualifyingAnswers ?? [] } });
      return Response.json({ field }, { status: 201 });
    } catch (error) {
      // Created concurrently between the check above and this insert.
      if (isUniqueViolation(error)) {
        return Response.json(
          { error: duplicateKeyMessage(body.key, false), code: "DUPLICATE_KEY" },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error, "Couldn't create the qualification field. Try again.");
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = editSchema.parse(await req.json());
    const existing = await prisma.qualificationField.findFirst({ where: { id: body.id, organisationId: session.organisationId } });
    if (!existing) return jsonError("Qualification field not found", 404);
    const { id, ...data } = body;
    if (data.key && data.key !== existing.key) {
      const clash = await prisma.qualificationField.findFirst({
        where: { organisationId: session.organisationId, key: data.key, id: { not: id } },
        select: { id: true, active: true },
      });
      if (clash) {
        return Response.json(
          { error: duplicateKeyMessage(data.key, !clash.active), code: "DUPLICATE_KEY" },
          { status: 409 },
        );
      }
    }
    try {
      await prisma.qualificationField.updateMany({
        where: { id, organisationId: session.organisationId },
        data,
      });
    } catch (error) {
      if (isUniqueViolation(error) && data.key) {
        return Response.json(
          { error: duplicateKeyMessage(data.key, false), code: "DUPLICATE_KEY" },
          { status: 409 },
        );
      }
      throw error;
    }
    const field = await prisma.qualificationField.findFirst({
      where: { id, organisationId: session.organisationId },
    });
    return Response.json({ field });
  } catch (error) {
    return errorResponse(error, "Couldn't update the qualification field. Try again.");
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonError("id is required");
    const result = await prisma.qualificationField.updateMany({ where: { id, organisationId: session.organisationId }, data: { active: false } });
    if (!result.count) return jsonError("Qualification field not found", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Couldn't deactivate the qualification field. Try again.");
  }
}
