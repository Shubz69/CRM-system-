"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

type Impersonation = {
  targetUserId: string;
  targetName: string;
  organisationId: string;
  organisationName?: string;
  startedAt: string;
  startedBy?: string;
};

export function ImpersonationBanner() {
  const [state, setState] = useState<Impersonation | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("dm_impersonation");
      if (raw) setState(JSON.parse(raw) as Impersonation);
    } catch {
      setState(null);
    }
  }, []);

  async function exit() {
    try {
      await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end" }),
      });
    } catch {
      // still clear local banner
    }
    sessionStorage.removeItem("dm_impersonation");
    setState(null);
    toast.success("Exited impersonation");
    // Full reload so session/JWT and middleware drop impersonation.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/admin/workspaces";
  }

  if (!state) return null;

  return (
    <div className="relative z-30 border-b border-[var(--accent)]/30 bg-[var(--accent-soft)] px-4 py-2 text-sm text-[var(--foreground)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <p>
          Impersonating <strong>{state.targetName}</strong>
          {state.organisationName ? ` · ${state.organisationName}` : ""} — started by{" "}
          {state.startedBy || "super admin"} at {new Date(state.startedAt).toLocaleString()}. Passwords
          are never exposed.
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => void exit()}>
          Exit impersonation
        </button>
      </div>
    </div>
  );
}
