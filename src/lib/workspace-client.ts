/**
 * Client helpers for workspace switch safety and expected-org mutation headers.
 *
 * Workspace-change signals are EVENTS (not permanent state).
 * A tab blocks only while its loaded snapshot is behind the event destination.
 * After reload/reinit into the current org+revision, the same localStorage event
 * must not re-arm the gate (no DevTools recovery).
 *
 * STORAGE_SCHEMA_VERSION bumps migrate legacy Round 3/4/4C/5 keys so long-lived
 * browser profiles recover without DevTools.
 */

import { EXPECTED_ORG_HEADER } from "@/lib/workspace-mutation-guard";
import { EXPECTED_WORKSPACE_REVISION_HEADER } from "@/lib/workspace-mutation-guard";

export const WORKSPACE_CHANNEL = "agent-desk-workspace";
export const STORAGE_EVENT_KEY = "agent-desk-workspace-event";
export const IMMUTABLE_CONTEXT_KEY = "agent-desk-workspace-context";
export const ACK_KEY = "agent-desk-workspace-event-ack";
/** Bumps when storage semantics change; triggers allowlisted migration. */
export const STORAGE_SCHEMA_VERSION = 6;
export const STORAGE_SCHEMA_VERSION_KEY = "agent-desk-workspace-storage-version";

const CHANNEL = WORKSPACE_CHANNEL;

/**
 * Every Agent Desk workspace-related key ever written (Rounds 3–5).
 * Migration may touch ONLY these — never auth/session/unrelated keys.
 */
export const ALL_WORKSPACE_STORAGE_KEYS = [
  STORAGE_EVENT_KEY,
  IMMUTABLE_CONTEXT_KEY,
  ACK_KEY,
  STORAGE_SCHEMA_VERSION_KEY,
] as const;

/** Keys that Round 4 briefly stored in localStorage (now session-only). */
export const LEGACY_LOCAL_CONTEXT_KEYS = [IMMUTABLE_CONTEXT_KEY] as const;

/**
 * New JS realm per full document load. sessionStorage survives reload, so a
 * previous page's frozen snapshot must be ignored until this load re-freezes.
 */
const DOCUMENT_LOAD_ID =
  typeof window !== "undefined"
    ? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    : "ssr";

let frozenForThisDocument = false;
let workspaceContextReady = false;
let storageMigrated = false;
const readyListeners = new Set<() => void>();

export type OrgChangedBroadcast = {
  type: "org-changed";
  organisationId: string;
  organisationName: string;
  workspaceRevision?: string | null;
  fromOrganisationId?: string | null;
  fromOrganisationName?: string | null;
  /** Unique id for this switch event (consumption / ack). */
  changeId?: string;
  eventId?: string;
  timestamp?: number;
};

export type ImmutableWorkspaceContext = {
  loadedOrganisationId: string | null;
  workspaceRevision: string | null;
  documentLoadId?: string;
};

function eventChangeId(event: OrgChangedBroadcast): string {
  return (
    event.changeId ||
    event.eventId ||
    `${event.organisationId}:${event.workspaceRevision || ""}:${event.timestamp || ""}`
  );
}

/** ISO revision compare: negative if a < b, 0 if equal, positive if a > b. */
export function compareWorkspaceRevisions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a === b) return 0;
  // ISO-8601 timestamps sort lexicographically.
  return a < b ? -1 : 1;
}

/**
 * Migrate/invalidate legacy Agent Desk workspace storage only.
 * Never clears entire localStorage/sessionStorage.
 */
export function migrateWorkspaceStorage(): { migrated: boolean; fromVersion: number } {
  if (typeof sessionStorage === "undefined" || typeof localStorage === "undefined") {
    return { migrated: false, fromVersion: STORAGE_SCHEMA_VERSION };
  }
  let fromVersion = 0;
  try {
    const raw = localStorage.getItem(STORAGE_SCHEMA_VERSION_KEY);
    fromVersion = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch {
    fromVersion = 0;
  }

  if (storageMigrated && fromVersion >= STORAGE_SCHEMA_VERSION) {
    return { migrated: false, fromVersion };
  }

  try {
    // Round 4: immutable context lived in localStorage — never authoritative after switch.
    for (const key of LEGACY_LOCAL_CONTEXT_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }

    // Pre-documentLoadId session snapshots re-arm the gate on every reload.
    try {
      const raw = sessionStorage.getItem(IMMUTABLE_CONTEXT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ImmutableWorkspaceContext;
        if (!parsed.documentLoadId) {
          sessionStorage.removeItem(IMMUTABLE_CONTEXT_KEY);
        }
      }
    } catch {
      try {
        sessionStorage.removeItem(IMMUTABLE_CONTEXT_KEY);
      } catch {
        /* ignore */
      }
    }

    // Normalize workspace event shape (ensure changeId when possible).
    try {
      const eventRaw = localStorage.getItem(STORAGE_EVENT_KEY);
      if (eventRaw) {
        const event = JSON.parse(eventRaw) as OrgChangedBroadcast;
        if (event?.type === "org-changed" && event.organisationId) {
          if (!event.changeId && !event.eventId) {
            const changeId = `${event.organisationId}:${event.workspaceRevision || ""}:${event.timestamp || Date.now()}`;
            localStorage.setItem(
              STORAGE_EVENT_KEY,
              JSON.stringify({ ...event, changeId, eventId: changeId }),
            );
          }
        } else {
          localStorage.removeItem(STORAGE_EVENT_KEY);
        }
      }
    } catch {
      try {
        localStorage.removeItem(STORAGE_EVENT_KEY);
      } catch {
        /* ignore */
      }
    }

    localStorage.setItem(STORAGE_SCHEMA_VERSION_KEY, String(STORAGE_SCHEMA_VERSION));
    storageMigrated = true;
  } catch {
    storageMigrated = true;
  }

  return { migrated: fromVersion < STORAGE_SCHEMA_VERSION, fromVersion };
}

/**
 * Before "Reload this tab": drop ONLY this tab's loaded snapshot + ack so the
 * next document load freezes authoritative org/revision. Keep the global
 * localStorage event for other stale tabs.
 */
export function prepareWorkspaceTabReload(): void {
  if (typeof sessionStorage === "undefined") return;
  migrateWorkspaceStorage();
  try {
    sessionStorage.removeItem(IMMUTABLE_CONTEXT_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(ACK_KEY);
  } catch {
    /* ignore */
  }
  // Allow a fresh freeze after soft re-init within the same module (tests).
  frozenForThisDocument = false;
  workspaceContextReady = false;
}

export function broadcastOrgChanged(msg: OrgChangedBroadcast) {
  migrateWorkspaceStorage();
  const changeId =
    msg.changeId ||
    msg.eventId ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const event: OrgChangedBroadcast = {
    ...msg,
    changeId,
    eventId: msg.eventId || changeId,
    timestamp: msg.timestamp || Date.now(),
  };
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
  migrateWorkspaceStorage();
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
  migrateWorkspaceStorage();
  try {
    const raw = localStorage.getItem(STORAGE_EVENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OrgChangedBroadcast;
    return parsed?.type === "org-changed" ? parsed : null;
  } catch {
    return null;
  }
}

function readAckedChangeId(): string | null {
  try {
    return sessionStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
}

/** Mark this document as having applied / caught up to the event (per-tab). */
export function acknowledgeOrgChangedEvent(event: OrgChangedBroadcast | null) {
  if (!event) return;
  try {
    sessionStorage.setItem(ACK_KEY, eventChangeId(event));
  } catch {
    /* ignore */
  }
}

/**
 * True when this tab's LOADED snapshot is still behind the switch destination.
 * If loaded org+revision already matches or is newer than the event destination,
 * the event is obsolete/consumed — do not block (fixes localStorage poison).
 */
export function workspaceGateShouldBlock(args: {
  currentOrganisationId?: string | null;
  currentWorkspaceRevision?: string | null;
  event: OrgChangedBroadcast | null;
}): boolean {
  const loadedOrg = args.currentOrganisationId;
  const event = args.event;
  if (!loadedOrg || !event?.organisationId) return false;

  const changeId = eventChangeId(event);
  if (changeId && readAckedChangeId() === changeId) return false;

  const destOrg = event.organisationId;
  const destRev = event.workspaceRevision || null;
  const loadedRev = args.currentWorkspaceRevision || null;

  // Still on a different organisation than the switch destination → stale.
  if (loadedOrg !== destOrg) return true;

  // Same org as destination: block only while loaded revision is strictly behind.
  if (destRev && loadedRev && compareWorkspaceRevisions(loadedRev, destRev) < 0) {
    return true;
  }

  // Same org, revision equal/newer/missing → event already reflected.
  return false;
}

export function isWorkspaceContextReady(): boolean {
  return workspaceContextReady;
}

export function subscribeWorkspaceContextReady(handler: () => void): () => void {
  if (workspaceContextReady) {
    handler();
    return () => undefined;
  }
  readyListeners.add(handler);
  return () => {
    readyListeners.delete(handler);
  };
}

export function setImmutableWorkspaceContext(ctx: ImmutableWorkspaceContext) {
  migrateWorkspaceStorage();
  try {
    if (frozenForThisDocument) return;
    frozenForThisDocument = true;
    workspaceContextReady = true;
    sessionStorage.setItem(
      IMMUTABLE_CONTEXT_KEY,
      JSON.stringify({ ...ctx, documentLoadId: DOCUMENT_LOAD_ID }),
    );
    // Never leave a localStorage copy (legacy Round 4).
    try {
      localStorage.removeItem(IMMUTABLE_CONTEXT_KEY);
    } catch {
      /* ignore */
    }
    // If current authoritative context already matches last event, acknowledge it
    // so reloads / new mounts never re-arm from an obsolete localStorage event.
    const last = readLastOrgChangedEvent();
    if (
      last &&
      !workspaceGateShouldBlock({
        currentOrganisationId: ctx.loadedOrganisationId,
        currentWorkspaceRevision: ctx.workspaceRevision,
        event: last,
      })
    ) {
      acknowledgeOrgChangedEvent(last);
    }
    for (const fn of readyListeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    readyListeners.clear();
  } catch {
    frozenForThisDocument = true;
    workspaceContextReady = true;
  }
}

export function getImmutableWorkspaceContext(
  fallbackOrganisationId?: string | null,
): ImmutableWorkspaceContext {
  migrateWorkspaceStorage();
  try {
    const raw = sessionStorage.getItem(IMMUTABLE_CONTEXT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ImmutableWorkspaceContext;
      // Missing documentLoadId = pre-v5/v6 legacy snapshot → treat as stale.
      // Mismatched documentLoadId = previous document load → ignore until re-freeze.
      if (!parsed.documentLoadId || parsed.documentLoadId !== DOCUMENT_LOAD_ID) {
        return {
          loadedOrganisationId: fallbackOrganisationId || null,
          workspaceRevision: null,
        };
      }
      return {
        loadedOrganisationId: parsed.loadedOrganisationId || fallbackOrganisationId || null,
        workspaceRevision: parsed.workspaceRevision || null,
        documentLoadId: parsed.documentLoadId,
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

// Boot migration as soon as this module loads in a browser-like environment.
if (typeof localStorage !== "undefined" && typeof sessionStorage !== "undefined") {
  migrateWorkspaceStorage();
}
