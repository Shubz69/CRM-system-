import { z } from "zod";
import { logger } from "@/lib/logger";
import { jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";

/** An error that maps straight to an HTTP response with a readable message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Parse a JSON object body. Invalid JSON or a non-object body is a 400, not a 500.
 * `allowEmpty` treats an empty body as `{}` (actions that need no input).
 */
export async function readJsonBody(
  req: Request,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, "Request body is required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** First zod issue as one readable sentence. Our own messages end with "."; zod defaults get the field name. */
export function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request.";
  if (issue.message.endsWith(".")) return issue.message;
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

/** Map any thrown error to a response; unexpected errors are logged and not leaked. */
export function errorResponse(error: unknown, action: string): Response {
  if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
  if (error instanceof HttpError) {
    return Response.json({ error: error.message, ...(error.extra ?? {}) }, { status: error.status });
  }
  if (error instanceof z.ZodError) return jsonError(zodMessage(error), 400);
  const message = error instanceof Error ? error.message : "";
  if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
  if (message.startsWith("Forbidden")) return jsonError(message, 403);
  logger.error(`${action} failed`, { message });
  return jsonError(`${action} failed. Please try again.`, 500);
}
