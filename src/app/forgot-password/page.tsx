"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { AuthFrame } from "@/components/ui/auth-frame";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [showOps, setShowOps] = useState(false);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResetUrl(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (bootstrapSecret.trim()) {
        headers["x-admin-bootstrap-secret"] = bootstrapSecret.trim();
      }
      const res = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers,
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      toast.success(json.message || "Check your email");
      if (json.resetUrl) setResetUrl(json.resetUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Reset password">
      <p className="mt-2 text-sm text-[var(--muted)]">
        Enter your account email. We never display your current password.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          Email
          <input
            className="input mt-1"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <button
          type="button"
          className="text-xs text-[var(--muted)] underline-offset-2 hover:underline"
          onClick={() => setShowOps((v) => !v)}
        >
          {showOps ? "Hide recovery options" : "No email yet? Use recovery secret"}
        </button>
        {showOps && (
          <label className="block text-sm">
            Admin bootstrap secret
            <input
              className="input mt-1 font-mono text-xs"
              type="password"
              value={bootstrapSecret}
              onChange={(e) => setBootstrapSecret(e.target.value)}
              placeholder="ADMIN_BOOTSTRAP_SECRET from Vercel"
              autoComplete="off"
            />
            <span className="mt-1 block text-xs text-[var(--muted)]">
              Same value as <code>ADMIN_BOOTSTRAP_SECRET</code>. Returns a one-time reset link when
              email SMTP is not configured.
            </span>
          </label>
        )}
        <button className="btn btn-primary w-full" type="submit" disabled={busy}>
          Send reset link
        </button>
      </form>
      {resetUrl && (
        <p className="mt-4 break-all text-xs text-[var(--muted)]">
          Reset link:{" "}
          <Link className="text-[var(--accent)] underline" href={resetUrl}>
            {resetUrl}
          </Link>
        </p>
      )}
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-[var(--accent)]">
          Back to login
        </Link>
      </p>
    </AuthFrame>
  );
}
