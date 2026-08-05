"use client";

import { FormEvent, useState } from "react";
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
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(15,107,92,0.18),transparent_35%),radial-gradient(circle_at_80%_10%,rgba(180,83,9,0.16),transparent_30%),linear-gradient(160deg,#10241f,#1d3b33_40%,#f3efe6_40%)]" />
      <div className="relative grid w-full max-w-5xl gap-8 lg:grid-cols-2">
        <div className="hidden text-white lg:flex lg:flex-col lg:justify-center">
          <p className="text-sm uppercase tracking-[0.2em] text-emerald-200/80">DM Intelligence CRM</p>
          <h1 className="mt-3 font-[family-name:var(--font-fraunces)] text-5xl leading-tight">
            Turn Instagram DMs into booked calls.
          </h1>
          <p className="mt-4 max-w-md text-emerald-50/80">
            AI qualification, human takeover, pipeline tracking, and conversation insights in one
            workspace.
          </p>
        </div>
        <form onSubmit={onSubmit} className="surface p-8 shadow-xl shadow-black/5">
          <h2 className="h-display text-3xl">Sign in</h2>
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
        </form>
      </div>
    </div>
  );
}
