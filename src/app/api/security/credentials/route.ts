import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  listCredentialHealth,
  markCredentialRotated,
} from "@/services/credential-health";
import { writeAuditLog } from "@/services/audit";

/**
 * GET /api/security/credentials — credential health metadata (no secrets).
 */
export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const report = await listCredentialHealth(session.organisationId);
    return Response.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const patchSchema = z.object({
  action: z.literal("mark_rotated"),
  kind: z.enum(["integration", "social"]),
  credentialId: z.string().min(1),
  note: z.string().max(500).optional(),
});

/**
 * PATCH — record that an operator rotated a credential externally.
 * Does not change ciphertext or ENCRYPTION_KEY.
 */
export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = patchSchema.parse(await req.json());
    await markCredentialRotated({
      organisationId: session.organisationId,
      kind: body.kind,
      credentialId: body.credentialId,
      note: body.note,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "security.credential_rotation_recorded",
      entityType: "Credential",
      entityId: body.credentialId,
      metadata: { kind: body.kind },
    });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
