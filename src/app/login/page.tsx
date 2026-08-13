import { Suspense } from "react";
import LoginClient from "./login-client";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="p-8 text-center text-[var(--muted)]">Loading…</main>}>
      <LoginClient />
    </Suspense>
  );
}
