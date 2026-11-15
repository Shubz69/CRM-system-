"use client";

import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

export type TagSummary = { id: string; name: string; color: string; contactCount?: number };
export type StageSummary = { id: string; name: string; position: number; slug?: string; color?: string };

/** Error carrying the server's own message (shown in toasts as-is). */
export class ContactsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContactsApiError";
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json = await res.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** GET a contacts/tags API route; throws with the server's error text. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await readJson(res);
  if (!res.ok) {
    throw new ContactsApiError(String(json.error || `Request failed (${res.status})`), res.status, json);
  }
  return json as T;
}

/** Mutating request with the workspace guard headers (a stale tab gets 409, never a silent write). */
export async function sendJson<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const ctx = getImmutableWorkspaceContext(null);
  const res = await workspaceFetch(ctx.loadedOrganisationId, ctx.workspaceRevision, url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await readJson(res);
  if (!res.ok) {
    throw new ContactsApiError(String(json.error || `Request failed (${res.status})`), res.status, json);
  }
  return json as T;
}

export function errorText(error: unknown, fallback = "Something went wrong"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function fetchTags(): Promise<TagSummary[]> {
  const json = await getJson<{ tags: TagSummary[] }>("/api/tags");
  return json.tags ?? [];
}

/** Where a lead goes when no stage is picked: the "new" stage, else the first (as the API does). */
export function defaultStage(stages: StageSummary[] | null | undefined): StageSummary | undefined {
  return stages?.find((s) => s.slug === "new") ?? stages?.[0];
}

export async function fetchStages(): Promise<StageSummary[]> {
  const json = await getJson<{ stages: StageSummary[] }>("/api/pipeline/stages");
  return json.stages ?? [];
}
