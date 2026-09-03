/**
 * Client helpers for workspace switch safety and expected-org mutation headers.
 */

import { EXPECTED_ORG_HEADER } from "@/lib/workspace-mutation-guard";

const CHANNEL = "agent-desk-workspace";

export type OrgChangedBroadcast = {
  type: "org-changed";
  organisationId: string;
  organisationName: string;
  fromOrganisationId?: string | null;
  fromOrganisationName?: string | null;
};

export function broadcastOrgChanged(msg: OrgChangedBroadcast) {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(msg);
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
  return () => {
    try {
      bc?.close();
    } catch {
      /* ignore */
    }
  };
}

/** Mutations must include the org the form was opened against. */
export function withExpectedOrganisation(
  organisationId: string | null | undefined,
  init?: RequestInit,
): RequestInit {
  if (!organisationId) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set(EXPECTED_ORG_HEADER, organisationId);
  return { ...init, headers };
}

export async function workspaceFetch(
  organisationId: string | null | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, withExpectedOrganisation(organisationId, init));
}
