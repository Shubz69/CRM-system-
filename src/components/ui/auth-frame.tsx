import type { ReactNode } from "react";

export function AuthFrame({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
}) {
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
        <div className="animate-rise-delay surface p-8">
          {eyebrow ? (
            <p className="text-sm font-semibold tracking-wide text-[var(--accent)]">{eyebrow}</p>
          ) : (
            <p className="text-sm font-semibold tracking-wide text-[var(--accent)] lg:hidden">
              Agent Desk
            </p>
          )}
          <h1 className="h-display mt-1 text-3xl">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}
