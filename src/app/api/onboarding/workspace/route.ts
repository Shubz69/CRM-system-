import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { jsonError } from "@/lib/session";
import {
  createWorkspaceWithOwner,
  OnboardingError,
} from "@/services/workspace-onboarding";

const bodySchema = z.object({
  workspaceName: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
    .optional(),
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(10).max(200).optional(),
  timezone: z.string().max(80).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());
    const session = await getServerSession(authOptions);

    if (session?.user?.id) {
      const result = await createWorkspaceWithOwner({
        name: body.workspaceName,
        slug: body.slug,
        ownerEmail: session.user.email || body.email || "",
        ownerName: body.name ?? session.user.name,
        existingUserId: session.user.id,
        password: body.password,
        timezone: body.timezone,
      });
      return Response.json({ ok: true, ...result });
    }

    if (!body.email || !body.password) {
      return jsonError("email and password are required to create a workspace", 400);
    }

    const result = await createWorkspaceWithOwner({
      name: body.workspaceName,
      slug: body.slug,
      ownerEmail: body.email,
      ownerName: body.name,
      password: body.password,
      timezone: body.timezone,
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
            : error.code === "FORBIDDEN"
              ? 403
              : 400;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : "Failed";
    return jsonError(message, 500);
  }
}
