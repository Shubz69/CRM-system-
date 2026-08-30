import { Suspense } from "react";
import AcceptInviteClient from "./accept-invite-client";

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<main className="p-8 text-center text-[var(--muted)]">Loading…</main>}>
      <AcceptInviteClient />
    </Suspense>
  );
}
