"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

export default function ResetPasswordClient() {
  const params = useSearchParams();
  const router = useRouter();
  const token = useMemo(() => params.get("token") || "", [params]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Reset failed");
      toast.success("Password updated — you can sign in");
      router.push("/login");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="surface p-6">
        <h1 className="h-display text-3xl">Choose a new password</h1>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block text-sm">
            New password
            <input
              className="input mt-1"
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Confirm password
            <input
              className="input mt-1"
              type="password"
              required
              minLength={10}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <button className="btn btn-primary w-full" type="submit" disabled={busy || !token}>
            Update password
          </button>
        </form>
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-[var(--accent)]">
            Back to login
          </Link>
        </p>
      </div>
    </main>
  );
}
