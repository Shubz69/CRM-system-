import { z } from "zod";
import { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";

/** An expected refusal with a status code and a message the UI can show as-is. */
export class RouteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

/** Every zod issue's own (human-written) message, de-duplicated. */
export function zodMessage(error: z.ZodError): string {
  const messages = [...new Set(error.issues.map((issue) => issue.message))];
  return messages.join("; ") || "Invalid request";
}

/** Parsed JSON object body; a malformed body is a 400, not a 500. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new RouteError(400, "Request body must be valid JSON");
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Map anything a route throws to a JSON error response. Unexpected errors stay generic. */
export function routeErrorResponse(error: unknown, context: string): Response {
  if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
  if (error instanceof RouteError) {
    return Response.json({ error: error.message, ...error.extra }, { status: error.status });
  }
  if (error instanceof z.ZodError) return jsonError(zodMessage(error), 400);
  const message = error instanceof Error ? error.message : "unknown";
  if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
  if (message.startsWith("Forbidden")) return jsonError(message, 403);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return jsonError("That conflicts with a change made at the same time — reload and try again.", 409);
  }
  logger.error(`${context} failed`, { message });
  return jsonError(`${context} failed`, 500);
}
