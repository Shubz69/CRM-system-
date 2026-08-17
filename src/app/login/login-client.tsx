"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthFrame } from "@/components/ui/auth-frame";

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const callbackUrl = searchParams.get("callbackUrl") || "/ask";
    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      redirect: false,
      callbackUrl,
    });
    setLoading(false);
    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push(callbackUrl.startsWith("/") ? callbackUrl : "/ask");
    router.refresh();
  }

  return (
    <AuthFrame title="Sign in">
      <p className="mt-2 text-sm text-[var(--muted)]">
        Use your workspace account. Platform admins can be bootstrapped via{" "}
        <code>/api/admin/bootstrap</code> when needed.
      </p>
      <form onSubmit={onSubmit}>
        <label className="mt-6 block text-sm font-medium">
          Email
          <input
            className="input mt-2"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          Password
          <input
            className="input mt-2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        <button className="btn btn-primary mt-6 w-full" disabled={loading} type="submit">
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-4 text-center text-sm text-[var(--muted)]">
          <Link href="/forgot-password" className="underline-offset-2 hover:underline">
            Forgot password?
          </Link>
          {" · "}
          <Link href="/" className="underline-offset-2 hover:underline">
            Back to home
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}
