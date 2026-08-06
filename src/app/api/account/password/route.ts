import { compare, hash } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = bodySchema.parse(await req.json());

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user?.passwordHash) {
      return jsonError("Account has no password set", 400);
    }

    const valid = await compare(body.currentPassword, user.passwordHash);
    if (!valid) {
      return jsonError("Current password is incorrect", 400);
    }

    if (body.currentPassword === body.newPassword) {
      return jsonError("New password must be different from the current password", 400);
    }

    const passwordHash = await hash(body.newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "account.password.changed",
      entityType: "User",
      entityId: user.id,
    });

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Invalid request", 400);
    }
    return jsonError(message, 500);
  }
}
