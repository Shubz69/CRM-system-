"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@dminelligence.local");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (result?.error) {
      setError("Invalid email or password");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="hero-plane absolute inset-0 animate-drift" aria-hidden />
      <div className="relative grid w-full max-w-5xl gap-8 lg:grid-cols-2">
        <div className="animate-rise hidden text-white lg:flex lg:flex-col lg:justify-center">
          <p className="font-[family-name:var(--font-fraunces)] text-4xl leading-tight">
            DM Intelligence
          </p>
          <p className="mt-4 max-w-md text-lg text-teal-50/80">
            Sign in to qualify Instagram DMs, book calls, and run your pipeline from one workspace.
          </p>
        </div>
        <form onSubmit={onSubmit} className="animate-rise-delay surface p-8 shadow-xl shadow-black/10">
          <p className="text-sm font-medium text-[var(--accent)] lg:hidden">DM Intelligence</p>
          <h1 className="h-display mt-1 text-3xl">Sign in</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Demo: demo@dminelligence.local / demo1234
          </p>
          <label className="mt-6 block text-sm font-medium">
            Email
            <input
              className="input mt-2"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
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
            />
          </label>
          {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
          <button className="btn btn-primary mt-6 w-full" disabled={loading} type="submit">
            {loading ? "Signing in…" : "Sign in"}
          </button>
          <p className="mt-4 text-center text-sm text-[var(--muted)]">
            <Link href="/" className="underline-offset-2 hover:underline">
              Back to home
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
