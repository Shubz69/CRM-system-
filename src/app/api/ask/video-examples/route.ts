import { NextRequest } from "next/server";
import { z } from "zod";
import {
  jsonError,
  requirePermissionForMutation,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { getVideoProvider, VideoProviderNotConfiguredError } from "@/adapters/video";
import { logger } from "@/lib/logger";

export const maxDuration = 60;

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  hook: z.string().min(1).max(500),
  shotList: z.array(z.string().min(1).max(400)).min(1).max(12),
  lengthSeconds: z.number().int().positive().max(180),
  platform: z.enum(["instagram", "linkedin", "tiktok", "youtube", "generic"]).optional(),
});

/**
 * Attempt to generate an Ask example video from a brief.
 * Fails closed with AUTH_REQUIRED when no video provider is wired.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("ask:use", req, raw);
    const body = bodySchema.parse(raw);

    try {
      const provider = getVideoProvider();
      const prompt = [
        body.title,
        `Hook: ${body.hook}`,
        `Shots:\n${body.shotList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        `Length: ${body.lengthSeconds}s`,
        body.platform ? `Platform: ${body.platform}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const result = await provider.generate({
        organisationId: session.organisationId,
        prompt,
        title: body.title,
        durationSeconds: body.lengthSeconds,
        aspectRatio: body.platform === "linkedin" ? "16:9" : "9:16",
      });
      logger.info("Ask example video generated", {
        organisationId: session.organisationId,
        provider: result.provider,
        model: result.model,
      });
      return Response.json({
        ok: true,
        provider: result.provider,
        model: result.model,
        mimeType: result.mimeType,
      });
    } catch (error) {
      if (error instanceof VideoProviderNotConfiguredError) {
        return Response.json(
          {
            ok: false,
            code: error.code,
            reason: error.reason,
            error: error.userFacingMessage,
          },
          { status: 503 },
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof WorkspaceChangedError) {
      return workspaceChangedJsonResponse();
    }
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    logger.warn("Ask video-examples error", { message });
    return jsonError("Could not generate an example video.", 503);
  }
}
