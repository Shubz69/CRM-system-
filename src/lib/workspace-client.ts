/**
 * Client helpers for workspace switch safety and expected-org mutation headers.
 */

import { EXPECTED_ORG_HEADER } from "@/lib/workspace-mutation-guard";
import { EXPECTED_WORKSPACE_REVISION_HEADER } from "@/lib/workspace-mutation-guard";

const CHANNEL = "agent-desk-workspace";
const STORAGE_EVENT_KEY = "agent-desk-workspace-event";
const IMMUTABLE_CONTEXT_KEY = "agent-desk-workspace-context";

export type OrgChangedBroadcast = {
  type: "org-changed";
  organisationId: string;
  organisationName: string;
  workspaceRevision?: string | null;
  fromOrganisationId?: string | null;
  fromOrganisationName?: string | null;
  eventId?: string;
};

export type ImmutableWorkspaceContext = {
  loadedOrganisationId: string | null;
  workspaceRevision: string | null;
};

export function broadcastOrgChanged(msg: OrgChangedBroadcast) {
  const event = { ...msg, eventId: msg.eventId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  try {
    localStorage.setItem(STORAGE_EVENT_KEY, JSON.stringify(event));
  } catch {
    /* storage unavailable */
  }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(event);
    bc.close();
  } catch {
    /* BroadcastChannel unavailable */
  }
}

export function subscribeOrgChanged(handler: (msg: OrgChangedBroadcast) => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (ev) => {
      const data = ev.data as OrgChangedBroadcast | undefined;
      if (data?.type === "org-changed" && data.organisationId) handler(data);
    };
  } catch {
    bc = null;
  }
  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== STORAGE_EVENT_KEY || !ev.newValue) return;
    try {
      const data = JSON.parse(ev.newValue) as OrgChangedBroadcast;
      if (data?.type === "org-changed" && data.organisationId) handler(data);
    } catch {
      /* ignore parse */
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener("storage", onStorage);
    try {
      bc?.close();
    } catch {
      /* ignore */
    }
  };
}

export function readLastOrgChangedEvent(): OrgChangedBroadcast | null {
  try {
    const raw = localStorage.getItem(STORAGE_EVENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OrgChangedBroadcast;
    return parsed?.type === "org-changed" ? parsed : null;
  } catch {
    return null;
  }
}

export function setImmutableWorkspaceContext(ctx: ImmutableWorkspaceContext) {
  try {
    const existing = localStorage.getItem(IMMUTABLE_CONTEXT_KEY);
    if (existing) return;
    localStorage.setItem(IMMUTABLE_CONTEXT_KEY, JSON.stringify(ctx));
  } catch {
    /* storage unavailable */
  }
}

export function getImmutableWorkspaceContext(
  fallbackOrganisationId?: string | null,
): ImmutableWorkspaceContext {
  try {
    const raw = localStorage.getItem(IMMUTABLE_CONTEXT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ImmutableWorkspaceContext;
      return {
        loadedOrganisationId: parsed.loadedOrganisationId || fallbackOrganisationId || null,
        workspaceRevision: parsed.workspaceRevision || null,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    loadedOrganisationId: fallbackOrganisationId || null,
    workspaceRevision: null,
  };
}

/** Mutations must include the org the form was opened against. */
export function withExpectedOrganisation(
  organisationId: string | null | undefined,
  workspaceRevision?: string | null,
  init?: RequestInit,
): RequestInit {
  if (!organisationId && !workspaceRevision) return init ?? {};
  const headers = new Headers(init?.headers);
  if (organisationId) headers.set(EXPECTED_ORG_HEADER, organisationId);
  if (workspaceRevision) headers.set(EXPECTED_WORKSPACE_REVISION_HEADER, workspaceRevision);
  return { ...init, headers };
}

export async function workspaceFetch(
  organisationId: string | null | undefined,
  workspaceRevision: string | null | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, withExpectedOrganisation(organisationId, workspaceRevision, init));
}
