"use client";

import { FormEvent, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";

export default function ChangePasswordPage() {
  const { update } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    if (newPassword.length < 10) {
      toast.error("New password must be at least 10 characters");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Could not update password");
        return;
      }

      // Refresh JWT so middleware no longer forces this page.
      await update({ mustChangePassword: false });
      toast.success("Password updated — opening dashboard");
      // Hard navigation ensures middleware reads the refreshed session cookie.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- must force full reload for JWT/middleware
      window.location.assign("/ask");
    } catch {
      toast.error("Could not update password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center lg:text-left">
        <h1 className="h-display text-3xl md:text-4xl">Change password</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Set a new password to continue. Navigation unlocks after this step.
        </p>
      </div>
      <form onSubmit={onSubmit} className="surface space-y-4 p-6">
        <label className="block text-sm font-medium">
          Current password
          <input
            className="input mt-2"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm font-medium">
          New password
          <input
            className="input mt-2"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={10}
          />
        </label>
        <label className="block text-sm font-medium">
          Confirm new password
          <input
            className="input mt-2"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={10}
          />
        </label>
        <button className="btn btn-primary w-full" type="submit" disabled={loading}>
          {loading ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}
