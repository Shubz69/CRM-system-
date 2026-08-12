import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

const schema = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = schema.parse(await req.json());
    const setting = await prisma.systemSetting.upsert({
      where: { key: body.key },
      create: { key: body.key, value: body.value as object },
      update: { value: body.value as object },
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "system.setting_updated",
      entityType: "SystemSetting",
      entityId: setting.id,
      metadata: { key: body.key },
    });
    return Response.json({ setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
