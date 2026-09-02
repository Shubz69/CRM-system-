"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AuthFrame } from "@/components/ui/auth-frame";

type InvitePreview = {
  email: string;
  role: string;
  status: string;
  organisationName: string;
  organisationDeleted?: boolean;
  expiresAt: string;
};

export default function AcceptInviteClient() {
  const params = useSearchParams();
  const router = useRouter();
  const token = useMemo(() => params.get("token") || "", [params]);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError("Missing invitation token");
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/onboarding/accept-invite?token=${encodeURIComponent(token)}`);
      const json = await res.json();
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(json.error || "Invalid invitation");
        return;
      }
      setPreview(json);
      setEmail(json.email || "");
    })().catch(() => {
      if (!cancelled) setLoadError("Could not load invitation");
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          email: email.trim().toLowerCase(),
          name: name.trim() || undefined,
          password: password || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Accept failed");

      toast.success(`Joined ${json.organisationName || "workspace"}`);

      if (password) {
        const signInResult = await signIn("credentials", {
          email: email.trim().toLowerCase(),
          password,
          redirect: false,
          callbackUrl: "/onboarding",
        });
        if (!signInResult?.error) {
          router.push("/onboarding");
          router.refresh();
          return;
        }
      }
      router.push("/login?callbackUrl=/onboarding");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Accept failed");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <AuthFrame title="Invitation unavailable">
        <p className="mt-3 text-sm text-[var(--danger)]">{loadError}</p>
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-[var(--accent)]">
            Back to login
          </Link>
        </p>
      </AuthFrame>
    );
  }

  if (!preview) {
    return (
      <AuthFrame title="Accept invitation">
        <p className="mt-3 text-sm text-[var(--muted)]">Loading invitation…</p>
      </AuthFrame>
    );
  }

  if (preview.organisationDeleted || preview.status !== "PENDING") {
    return (
      <AuthFrame title="Invitation unavailable">
        <p className="mt-3 text-sm text-[var(--muted)]">
          This invitation is {preview.status.toLowerCase()} and can no longer be accepted.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-[var(--accent)]">
            Back to login
          </Link>
        </p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Join workspace">
      <p className="mt-2 text-sm text-[var(--muted)]">
        You&apos;ve been invited to <strong>{preview.organisationName}</strong> as{" "}
        {preview.role.replace(/_/g, " ")}.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm font-medium">
          Email
          <input
            className="input mt-2"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="block text-sm font-medium">
          Name
          <input
            className="input mt-2"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </label>
        <label className="block text-sm font-medium">
          Password
          <input
            className="input mt-2"
            type="password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="Required for new accounts"
          />
        </label>
        <button className="btn btn-primary w-full" type="submit" disabled={busy || !token}>
          {busy ? "Joining…" : "Accept invitation"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-[var(--muted)]">
        <Link href="/login" className="underline-offset-2 hover:underline">
          Already have an account? Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
