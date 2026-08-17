import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getMissingRuntimeConfig } from "@/lib/env";

export default async function HomePage() {
  let signedIn = false;
  try {
    const session = await getServerSession(authOptions);
    signedIn = Boolean(session?.user);
  } catch (error) {
    console.error("Session check failed on home page", error);
  }

  if (signedIn) {
    redirect("/ask");
  }

  const missing = getMissingRuntimeConfig();

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="hero-plane absolute inset-0 animate-drift" aria-hidden />
      <div className="hero-desk-grid absolute inset-0" aria-hidden />
      <div
        className="animate-pulse-soft pointer-events-none absolute -right-16 top-1/3 h-[28rem] w-[28rem] rounded-full bg-[var(--hero-mist)]/15 blur-3xl"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-8 md:px-10">
        <header className="animate-rise flex items-center justify-end">
          <Link
            href="/login"
            className="btn border border-white/20 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur-sm"
          >
            Sign in
          </Link>
        </header>

        {missing.length > 0 && (
          <div className="animate-rise mt-6 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm text-white">
            <p className="font-semibold">Deployment needs environment variables</p>
            <p className="mt-1 text-white/80">
              Add these in Vercel → Settings → Environment Variables, then redeploy:{" "}
              {missing.join(", ")}.
            </p>
          </div>
        )}

        <section className="flex flex-1 flex-col justify-center py-16 md:py-24">
          <p className="animate-rise font-[family-name:var(--font-fraunces)] text-6xl leading-[0.95] text-white md:text-7xl lg:text-8xl">
            Agent Desk
          </p>
          <p className="animate-rise-delay mt-6 max-w-lg text-lg text-white/75 md:text-xl">
            Ask agents to research, listen, qualify, and book — one desk for the work.
          </p>
          <div className="animate-rise-delay-2 mt-10">
            <Link href="/login" className="btn btn-primary px-7 py-3.5 text-base">
              Open your desk
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
