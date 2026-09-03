"use client";

/**
 * Option B — session-wide workspace change: block mutations until the operator
 * acknowledges and reloads. Never silently rewrite the tab mid-edit.
 */

import { useEffect, useState } from "react";
import {
  readLastOrgChangedEvent,
  subscribeOrgChanged,
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
    const existing = readLastOrgChangedEvent();
    if (
      existing &&
      existing.organisationId &&
      (existing.organisationId !== currentOrganisationId ||
        (existing.workspaceRevision &&
          currentWorkspaceRevision &&
          existing.workspaceRevision !== currentWorkspaceRevision))
    ) {
      setPending(existing);
    }
    return subscribeOrgChanged((msg) => {
      if (!msg.organisationId) return;
      if (
        currentOrganisationId &&
        msg.organisationId === currentOrganisationId &&
        (!msg.workspaceRevision ||
          !currentWorkspaceRevision ||
          msg.workspaceRevision === currentWorkspaceRevision)
      ) {
        return;
      }
      setPending(msg);
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
    // Capture-phase: stop form submits and mutation-like clicks until reload.
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
