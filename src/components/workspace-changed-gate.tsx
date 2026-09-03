"use client";

/**
 * Option B — session-wide workspace change: block mutations until the operator
 * acknowledges and reloads. Never silently rewrite the tab mid-edit.
 *
 * CRITICAL: compare against this tab's immutable loaded snapshot (sessionStorage),
 * NOT live session.organisationId. Cookies are shared across tabs — when Tab B
 * switches, Tab A's NextAuth session can update to B without a reload. Using the
 * live session would clear the gate and let stale forms submit.
 */

import { useEffect, useState } from "react";
import {
  getImmutableWorkspaceContext,
  readLastOrgChangedEvent,
  subscribeOrgChanged,
  workspaceGateShouldBlock,
  type OrgChangedBroadcast,
} from "@/lib/workspace-client";

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
    // Prefer the per-tab loaded snapshot. Fall back to props only before freeze.
    const snap = getImmutableWorkspaceContext(currentOrganisationId ?? null);
    const baselineOrg = snap.loadedOrganisationId || currentOrganisationId || null;
    const baselineRev = snap.workspaceRevision || currentWorkspaceRevision || null;

    // Wait until this tab has a known loaded org — avoid hydration false-positives.
    if (!baselineOrg) return;

    const existing = readLastOrgChangedEvent();
    if (
      workspaceGateShouldBlock({
        currentOrganisationId: baselineOrg,
        currentWorkspaceRevision: baselineRev,
        event: existing,
      })
    ) {
      setPending(existing);
    } else {
      setPending(null);
    }

    return subscribeOrgChanged((msg) => {
      const latest = getImmutableWorkspaceContext(baselineOrg);
      const org = latest.loadedOrganisationId || baselineOrg;
      const rev = latest.workspaceRevision || baselineRev;
      if (
        workspaceGateShouldBlock({
          currentOrganisationId: org,
          currentWorkspaceRevision: rev,
          event: msg,
        })
      ) {
        setPending(msg);
      }
    });
  }, [currentOrganisationId, currentWorkspaceRevision]);

  useEffect(() => {
    if (!pending) return;
    const block = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-workspace-gate]")) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("click", block, true);
    document.addEventListener("keydown", block, true);
    document.addEventListener("submit", block, true);
    return () => {
      document.removeEventListener("click", block, true);
      document.removeEventListener("keydown", block, true);
      document.removeEventListener("submit", block, true);
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
            onClick={() => {
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
