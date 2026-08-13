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
      <div
        className="animate-pulse-soft pointer-events-none absolute -left-24 top-24 h-72 w-72 rounded-full bg-[var(--hero-mist)]/20 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 right-0 h-[50vh] w-[55vw] bg-[url('data:image/svg+xml,%3Csvg width=%2760%27 height=%2760%27 viewBox=%270 0 60 60%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cg fill=%27none%27 fill-rule=%27evenodd%27%3E%3Cg fill=%27%23ffffff%27 fill-opacity=%270.04%27%3E%3Cpath d=%27M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z%27/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')]"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 md:px-10">
        <header className="animate-rise flex items-center justify-between gap-4">
          <p className="font-[family-name:var(--font-fraunces)] text-2xl text-white md:text-3xl">
            DM Intelligence
          </p>
          <Link href="/login" className="btn btn-secondary bg-white/95 text-[var(--foreground)]">
            Sign in
          </Link>
        </header>

        {missing.length > 0 && (
          <div className="animate-rise mt-6 rounded-2xl border border-amber-300/40 bg-amber-400/15 px-4 py-3 text-sm text-amber-50">
            <p className="font-semibold">Deployment needs environment variables</p>
            <p className="mt-1 text-amber-50/85">
              Add these in Vercel → Settings → Environment Variables, then redeploy:{" "}
              {missing.join(", ")}.
            </p>
          </div>
        )}

        <section className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div>
            <h1 className="animate-rise-delay font-[family-name:var(--font-fraunces)] text-5xl leading-[1.05] text-white md:text-6xl lg:text-7xl">
              DM Intelligence
            </h1>
            <p className="animate-rise-delay-2 mt-5 max-w-xl text-lg text-teal-50/85 md:text-xl">
              Qualify Instagram conversations, book calls, and turn every DM into pipeline
              intelligence.
            </p>
            <div className="animate-rise-delay-2 mt-8 flex flex-wrap gap-3">
              <Link href="/login" className="btn btn-primary px-6 py-3 text-base">
                Open the workspace
              </Link>
              <Link
                href="/login"
                className="btn border border-white/25 bg-white/10 px-6 py-3 text-base text-white backdrop-blur"
              >
                Try the demo
              </Link>
            </div>
          </div>

          <div className="animate-rise-delay relative min-h-[360px] lg:min-h-[460px]" aria-hidden>
            <div className="dm-thread absolute inset-0 rounded-[28px] p-5 md:p-6">
              <div className="mb-5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-teal-300/30 ring-1 ring-white/20" />
                <div>
                  <p className="text-sm font-semibold text-white">@coach_maya</p>
                  <p className="text-xs text-teal-100/70">Instagram · Active now</p>
                </div>
              </div>
              <div className="space-y-3">
                <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/12 px-4 py-3 text-sm text-teal-50">
                  I get about 500 DMs a month for my coaching business. How much does this cost?
                </div>
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-md bg-[var(--accent)] px-4 py-3 text-sm text-white">
                  Starter plans begin around £497/month for a single inbox. Want a quick call to map
                  your volume?
                </div>
                <div className="max-w-[75%] rounded-2xl rounded-tl-md bg-white/12 px-4 py-3 text-sm text-teal-50">
                  Yes — book me in this week.
                </div>
                <div className="rounded-2xl border border-emerald-300/30 bg-emerald-400/10 px-4 py-3 text-xs text-emerald-100">
                  Qualified · Score 82 · Booking link sent · Stage: Booking offered
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
