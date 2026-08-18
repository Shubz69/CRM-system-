import { Suspense } from "react";
import IntegrationsClient from "./integrations-client";

export default function Page() {
  return (
    <Suspense fallback={<div className="surface p-6 text-[var(--muted)]">Loading integrations…</div>}>
      <IntegrationsClient />
    </Suspense>
  );
}
