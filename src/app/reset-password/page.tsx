import { Suspense } from "react";
import ResetPasswordClient from "./reset-client";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="p-8 text-center text-[var(--muted)]">Loading…</main>}>
      <ResetPasswordClient />
    </Suspense>
  );
}
