/**
 * Expected-organisation mutation guard.
 * Client sends the workspace it believes is active; server compares to
 * authoritative session org. Mismatch → 409 WORKSPACE_CHANGED (never silent write).
 */

export const EXPECTED_ORG_HEADER = "x-expected-organisation-id";
export const EXPECTED_WORKSPACE_REVISION_HEADER = "x-expected-workspace-revision";

export class WorkspaceChangedError extends Error {
  readonly code = "WORKSPACE_CHANGED" as const;
  constructor(message = "Workspace changed in another tab. Reload before continuing.") {
    super(message);
    this.name = "WorkspaceChangedError";
  }
}

export function readExpectedOrganisationId(
  req: Request,
  body?: Record<string, unknown> | null,
): string | null {
  const header = req.headers.get(EXPECTED_ORG_HEADER)?.trim();
  if (header) return header;
  if (body && typeof body.expectedOrganisationId === "string" && body.expectedOrganisationId.trim()) {
    return body.expectedOrganisationId.trim();
  }
  return null;
}

export function readExpectedWorkspaceRevision(
  req: Request,
  body?: Record<string, unknown> | null,
): string | null {
  const header = req.headers.get(EXPECTED_WORKSPACE_REVISION_HEADER)?.trim();
  if (header) return header;
  if (body && typeof body.expectedWorkspaceRevision === "string" && body.expectedWorkspaceRevision.trim()) {
    return body.expectedWorkspaceRevision.trim();
  }
  return null;
}

/**
 * When the client declares an expected org, it must match the session org.
 * Missing expected id is allowed (older clients) — mismatch is never allowed.
 */
export function assertExpectedOrganisation(
  activeOrganisationId: string,
  expectedOrganisationId: string | null | undefined,
): void {
  if (!expectedOrganisationId) return;
  if (expectedOrganisationId !== activeOrganisationId) {
    throw new WorkspaceChangedError();
  }
}

export function assertExpectedWorkspaceRevision(
  activeWorkspaceRevision: string,
  expectedWorkspaceRevision: string | null | undefined,
): void {
  if (!expectedWorkspaceRevision) return;
  if (expectedWorkspaceRevision !== activeWorkspaceRevision) {
    throw new WorkspaceChangedError();
  }
}

export function workspaceChangedJsonResponse() {
  return Response.json(
    {
      error: "Workspace changed in another tab. Reload before continuing.",
      code: "WORKSPACE_CHANGED",
    },
    { status: 409 },
  );
}
