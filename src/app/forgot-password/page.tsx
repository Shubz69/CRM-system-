"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { AuthFrame } from "@/components/ui/auth-frame";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResetUrl(null);
    try {
      const res = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          />
        </label>
        <button className="btn btn-primary w-full" type="submit" disabled={busy}>
          Send reset link
        </button>
      </form>
      {resetUrl && (
        <p className="mt-4 break-all text-xs text-[var(--muted)]">
          Dev reset link: <Link href={resetUrl}>{resetUrl}</Link>
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
