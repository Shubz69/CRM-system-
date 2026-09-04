"use client";

/**
 * Option B — session-wide workspace change: block mutations until the operator
 * acknowledges and reloads. Never silently rewrite the tab mid-edit.
 *
 * CRITICAL: compare against this tab's immutable loaded snapshot (sessionStorage),
 * NOT live session.organisationId. Cookies are shared across tabs — when Tab B
 * switches, Tab A's NextAuth session can update to B without a reload. Using the
 * live session would clear the gate and let stale forms submit.
 *
 * Event lifecycle: localStorage holds the latest switch EVENT. After reload into
 * the destination org+revision, the event is acknowledged and must not re-block.
 */

import { useEffect, useState } from "react";
import {
  acknowledgeOrgChangedEvent,
  getImmutableWorkspaceContext,
  isWorkspaceContextReady,
  migrateWorkspaceStorage,
  prepareWorkspaceTabReload,
  readLastOrgChangedEvent,
  subscribeOrgChanged,
  subscribeWorkspaceContextReady,
  workspaceGateShouldBlock,
  type OrgChangedBroadcast,
} from "@/lib/workspace-client";

function evaluateGate(
  currentOrganisationId: string | null | undefined,
  currentWorkspaceRevision: string | null | undefined,
  event: OrgChangedBroadcast | null,
): OrgChangedBroadcast | null {
  const snap = getImmutableWorkspaceContext(currentOrganisationId ?? null);
  // Prefer frozen snapshot once ready; never treat a previous-document freeze as truth.
  // Org must stay snap-first (live session can update across tabs without reload).
  const baselineOrg = isWorkspaceContextReady()
    ? snap.loadedOrganisationId || currentOrganisationId || null
    : snap.loadedOrganisationId || null;
  const baselineRev = isWorkspaceContextReady()
    ? snap.workspaceRevision || null
    : snap.workspaceRevision || null;

  if (!baselineOrg) return null;

  if (
    workspaceGateShouldBlock({
      currentOrganisationId: baselineOrg,
      currentWorkspaceRevision: baselineRev,
      // Live prop may be newer after /api/organisations refresh post-reload.
      liveWorkspaceRevision: isWorkspaceContextReady() ? currentWorkspaceRevision : null,
      event,
    })
  ) {
    return event;
  }
  if (event) acknowledgeOrgChangedEvent(event);
  return null;
}

export function WorkspaceChangedGate({
  currentOrganisationId,
  currentWorkspaceRevision,
  currentOrganisationName,
}: {
  currentOrganisationId?: string | null;
  currentWorkspaceRevision?: string | null;
  currentOrganisationName?: string | null;
}) {
  const [pending, setPending] = useState<OrgChangedBroadcast | null>(null);

  useEffect(() => {
    migrateWorkspaceStorage();

    function recompute(event?: OrgChangedBroadcast | null) {
      const existing = event === undefined ? readLastOrgChangedEvent() : event;
      const next = evaluateGate(currentOrganisationId, currentWorkspaceRevision, existing);
      setPending(next);
      // Explicit clear when authoritative context matches destination — never leave
      // a stale React pending=true after reload recovery.
      if (!next) {
        document.documentElement.dataset.workspaceGate = "clear";
      } else {
        document.documentElement.dataset.workspaceGate = "blocked";
      }
    }

    // Do not arm from localStorage until this document has frozen authoritative context
    // (avoids reload re-blocking from a previous page's sessionStorage snapshot).
    if (isWorkspaceContextReady()) {
      recompute();
    } else {
      setPending(null);
      document.documentElement.dataset.workspaceGate = "clear";
    }

    const unsubReady = subscribeWorkspaceContextReady(() => recompute());
    const unsub = subscribeOrgChanged((msg) => {
      // Live events always evaluate immediately — even before freeze — using the
      // last known immutable snapshot so open forms block without waiting.
      const snap = getImmutableWorkspaceContext(currentOrganisationId ?? null);
      const org = snap.loadedOrganisationId || currentOrganisationId || null;
      const rev = snap.workspaceRevision || null;
      if (
        org &&
        workspaceGateShouldBlock({
          currentOrganisationId: org,
          currentWorkspaceRevision: rev,
          liveWorkspaceRevision: currentWorkspaceRevision,
          event: msg,
        })
      ) {
        setPending(msg);
        document.documentElement.dataset.workspaceGate = "blocked";
      } else if (msg) {
        // Destination already reflected in this tab — consume and keep clear.
        const next = evaluateGate(currentOrganisationId, currentWorkspaceRevision, msg);
        setPending(next);
        document.documentElement.dataset.workspaceGate = next ? "blocked" : "clear";
      }
    });

    return () => {
      unsub();
      unsubReady();
    };
  }, [currentOrganisationId, currentWorkspaceRevision]);

  useEffect(() => {
    // CRITICAL: no capture listeners while unblocked / loading — they swallow first clicks.
    if (!pending) {
      document.documentElement.dataset.workspaceGate = "clear";
      return;
    }
    document.documentElement.dataset.workspaceGate = "blocked";
    const block = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-workspace-gate]")) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    };
    document.addEventListener("pointerdown", block, true);
    document.addEventListener("click", block, true);
    document.addEventListener("keydown", block, true);
    document.addEventListener("submit", block, true);
    return () => {
      document.removeEventListener("pointerdown", block, true);
      document.removeEventListener("click", block, true);
      document.removeEventListener("keydown", block, true);
      document.removeEventListener("submit", block, true);
      // Cleanup must restore clear state so listeners never linger after unmount.
      if (!pending) {
        document.documentElement.dataset.workspaceGate = "clear";
      }
    };
  }, [pending]);

  if (!pending) return null;

  const fromName =
    pending.fromOrganisationName || currentOrganisationName || "the previous workspace";
  const toName = pending.organisationName || "another workspace";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="workspace-changed-title"
      aria-describedby="workspace-changed-desc"
      data-workspace-gate-overlay="true"
      style={{ pointerEvents: "auto" }}
    >
      <div className="surface max-w-md rounded-2xl p-6 shadow-2xl" data-workspace-gate>
        <h2 id="workspace-changed-title" className="font-[family-name:var(--font-fraunces)] text-xl">
          Workspace changed
        </h2>
        <p id="workspace-changed-desc" className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
          Another tab switched from <span className="font-medium text-[var(--foreground)]">{fromName}</span>{" "}
          to <span className="font-medium text-[var(--foreground)]">{toName}</span>. Saves and sends are
          blocked here until you reload so nothing lands in the wrong account.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="workspace-gate-reload"
            onClick={() => {
              // Discard only this tab's stale loaded snapshot, then hard-reload.
              // Keeps the global switch EVENT so other stale tabs can still detect it.
              prepareWorkspaceTabReload();
              window.location.reload();
            }}
          >
            Reload this tab
          </button>
        </div>
      </div>
    </div>
  );
}
