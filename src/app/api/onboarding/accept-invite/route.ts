import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/session";
import {
  acceptInvite,
  getInviteByToken,
  OnboardingError,
} from "@/services/workspace-onboarding";

const acceptSchema = z.object({
  token: z.string().min(20),
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(10).max(200).optional(),
});

const previewSchema = z.object({
  token: z.string().min(20),
});

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token") || "";
    previewSchema.parse({ token });
    const invite = await getInviteByToken(token);
    if (!invite) return jsonError("Invalid or expired invitation", 404);
    return Response.json({
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
      organisationName: invite.organisation.name,
      organisationDeleted: Boolean(invite.organisation.deletedAt),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid token", 400);
    const message = error instanceof Error ? error.message : "Failed";
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = acceptSchema.parse(await req.json());
    const result = await acceptInvite({
      token: body.token,
      email: body.email,
      name: body.name,
      password: body.password,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(error.errors[0]?.message || "Invalid request", 400);
    }
    if (error instanceof OnboardingError) {
      const status =
        error.code === "CONFLICT"
          ? 409
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "FORBIDDEN" || error.code === "REVOKED"
              ? 403
              : error.code === "EXPIRED" || error.code === "REPLAY"
                ? 410
                : 400;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : "Failed";
    return jsonError(message, 500);
  }
}
