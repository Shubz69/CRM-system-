"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="hero-plane absolute inset-0 animate-drift" aria-hidden />
      <div className="hero-desk-grid absolute inset-0" aria-hidden />
      <div className="relative grid w-full max-w-5xl gap-10 lg:grid-cols-2 lg:items-center">
        <div className="animate-rise hidden text-white lg:block">
          <p className="font-[family-name:var(--font-fraunces)] text-5xl leading-tight">
            Agent Desk
          </p>
          <p className="mt-5 max-w-md text-lg text-white/70">
            Research markets, listen for trends, qualify conversations, and run your pipeline from
            one desk.
          </p>
        </div>
        <form onSubmit={onSubmit} className="animate-rise-delay surface p-8">
          <p className="text-sm font-semibold tracking-wide text-[var(--accent)] lg:hidden">
            Agent Desk
          </p>
          <h1 className="h-display mt-1 text-3xl">Sign in</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Use your workspace account. Platform admins can be bootstrapped via{" "}
            <code>/api/admin/bootstrap</code> when needed.
          </p>
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
      </div>
    </div>
  );
}
