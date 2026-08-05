import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

const fieldSchema = z.object({
  id: z.string().optional(),
  key: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  fieldType: z.string().trim().min(1).max(50).optional(),
  required: z.boolean().optional(),
  weight: z.number().int().min(0).max(100).optional(),
  position: z.number().int().min(0).optional(),
  options: z.array(z.string()).optional(),
  disqualifyingAnswers: z.array(z.string()).optional(),
});

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const fields = await prisma.qualificationField.findMany({ where: { organisationId: session.organisationId }, orderBy: { position: "asc" } });
    return Response.json({ fields });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = fieldSchema.required({ key: true, label: true }).parse(await req.json());
    const field = await prisma.qualificationField.create({ data: { organisationId: session.organisationId, key: body.key, label: body.label, fieldType: body.fieldType ?? "short_text", required: body.required ?? false, weight: body.weight ?? 10, position: body.position ?? 0, options: body.options ?? [], disqualifyingAnswers: body.disqualifyingAnswers ?? [] } });
    return Response.json({ field }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = fieldSchema.extend({ id: z.string() }).parse(await req.json());
    const existing = await prisma.qualificationField.findFirst({ where: { id: body.id, organisationId: session.organisationId } });
    if (!existing) return jsonError("Qualification field not found", 404);
    const { id, ...data } = body;
    const field = await prisma.qualificationField.update({ where: { id }, data });
    return Response.json({ field });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
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
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
