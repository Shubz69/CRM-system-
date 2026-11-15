"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { toast } from "sonner";

export function NoWorkspaceActions({
  otherWorkspace,
}: {
  otherWorkspace: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const { update } = useSession();
  const [busy, setBusy] = useState(false);

  async function openOther() {
    if (!otherWorkspace) return;
    setBusy(true);
    try {
      const next = await update({ organisationId: otherWorkspace.id });
      if (next?.user?.organisationId !== otherWorkspace.id) {
        throw new Error("Couldn't open that workspace. Please sign out and sign in again.");
      }
      router.replace("/home");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't open that workspace");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {otherWorkspace ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void openOther()}
        >
          Open {otherWorkspace.name}
        </button>
      ) : null}
      <button
        type="button"
        className={otherWorkspace ? "btn btn-secondary" : "btn btn-primary"}
        onClick={() => void signOut({ callbackUrl: "/login" })}
      >
        Sign out
      </button>
    </div>
  );
}
