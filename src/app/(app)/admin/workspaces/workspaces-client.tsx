"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  autopilotMode: string;
  owner: { id: string; email: string; name: string | null } | null;
  users: number;
  contacts: number;
  conversations: number;
  aiStatus: string;
  manychatStatus: string;
  bookingStatus: string;
  createdAt: string;
  lastActivityAt: string | null;
  demoData: boolean;
};

export function WorkspacesClient({ initial }: { initial: WorkspaceRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/admin/workspaces");
    if (!res.ok) return;
    const json = await res.json();
    setRows(json.workspaces || []);
  }

  async function createWorkspace(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    try {
      const res = await fetch("/api/admin/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, slug }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      toast.success("Workspace created");
      setName("");
      setSlug("");
      await refresh();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(null);
    }
  }

  async function mutate(organisationId: string, action: "suspend" | "reactivate" | "update", extra?: object) {
    setBusy(`${action}-${organisationId}`);
    try {
      const res = await fetch("/api/admin/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, organisationId, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Action failed");
      toast.success(action === "update" ? "Saved" : action === "suspend" ? "Suspended" : "Reactivated");
      await refresh();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function impersonate(organisationId: string, targetUserId?: string) {
    if (!targetUserId) {
      toast.error("No owner user to impersonate for this workspace");
      return;
    }
    setBusy(`impersonate-${organisationId}`);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", targetUserId, organisationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Impersonation failed");
      sessionStorage.setItem("dm_impersonation", JSON.stringify(json.impersonation));
      await fetch("/api/session/organisation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organisationId }),
      });
      toast.success(`Viewing workspace as ${json.impersonation.targetName}`);
      // Full reload so session/JWT and middleware pick up the impersonation cookie.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/dashboard";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impersonation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={createWorkspace} className="surface flex flex-wrap items-end gap-3 p-4">
        <label className="text-sm">
          <span className="text-[var(--muted)]">Workspace name</span>
          <input
            className="mt-1 block w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, "-")) {
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
              }
            }}
            required
          />
        </label>
        <label className="text-sm">
          <span className="text-[var(--muted)]">Slug</span>
          <input
            className="mt-1 block w-48 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            pattern="[a-z0-9-]+"
          />
        </label>
        <button className="btn btn-primary" disabled={busy === "create"} type="submit">
          Create workspace
        </button>
      </form>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Workspace</th>
              <th className="px-3 py-3">Owner</th>
              <th className="px-3 py-3">Plan</th>
              <th className="px-3 py-3">Users</th>
              <th className="px-3 py-3">Contacts</th>
              <th className="px-3 py-3">Conversations</th>
              <th className="px-3 py-3">AI</th>
              <th className="px-3 py-3">ManyChat</th>
              <th className="px-3 py-3">Booking</th>
              <th className="px-3 py-3">Created</th>
              <th className="px-3 py-3">Activity</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((org) => (
              <tr key={org.id} className="border-b border-[var(--border)]/60 align-top">
                <td className="px-3 py-3">
                  <div className="font-medium">{org.name}</div>
                  <div className="text-xs text-[var(--muted)]">{org.slug}</div>
                  <div className="mt-1 text-xs text-[var(--muted)]">Autopilot: {org.autopilotMode}</div>
                </td>
                <td className="px-3 py-3 text-[var(--muted)]">{org.owner?.email || "—"}</td>
                <td className="px-3 py-3">
                  <input
                    className="w-24 rounded border border-[var(--border)] px-2 py-1"
                    defaultValue={org.plan}
                    onBlur={(e) => {
                      if (e.target.value !== org.plan) {
                        void mutate(org.id, "update", { plan: e.target.value });
                      }
                    }}
                  />
                </td>
                <td className="px-3 py-3">{org.users}</td>
                <td className="px-3 py-3">{org.contacts}</td>
                <td className="px-3 py-3">{org.conversations}</td>
                <td className="px-3 py-3">{org.aiStatus}</td>
                <td className="px-3 py-3">{org.manychatStatus}</td>
                <td className="px-3 py-3">{org.bookingStatus}</td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {new Date(org.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {org.lastActivityAt ? new Date(org.lastActivityAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-3">
                  <span className={org.status === "SUSPENDED" ? "badge badge-warn" : "badge"}>
                    {org.status}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <div className="flex min-w-[160px] flex-col gap-1">
                    <a className="text-[var(--accent)] hover:underline" href={`/dashboard`}>
                      Open
                    </a>
                    <a className="text-[var(--accent)] hover:underline" href={`/admin/users?organisationId=${org.id}`}>
                      View users
                    </a>
                    <a className="text-[var(--accent)] hover:underline" href={`/admin/usage`}>
                      View usage
                    </a>
                    <a className="text-[var(--accent)] hover:underline" href={`/admin/audit`}>
                      Audit log
                    </a>
                    {org.status === "SUSPENDED" ? (
                      <button
                        type="button"
                        className="text-left text-[var(--accent)] hover:underline"
                        disabled={busy === `reactivate-${org.id}`}
                        onClick={() => void mutate(org.id, "reactivate")}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-left text-[var(--danger)] hover:underline"
                        disabled={busy === `suspend-${org.id}`}
                        onClick={() => void mutate(org.id, "suspend")}
                      >
                        Suspend
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-left text-[var(--accent)] hover:underline"
                      disabled={busy === `impersonate-${org.id}` || !org.owner?.id}
                      onClick={() => void impersonate(org.id, org.owner?.id)}
                    >
                      Impersonate workspace
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-6 text-sm text-[var(--muted)]">No workspaces yet. Create one above.</p>
        )}
      </div>
    </div>
  );
}
