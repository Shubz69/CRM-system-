import { Suspense } from "react";
import IntegrationsClient from "./integrations-client";

function IntegrationsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading integrations">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-[var(--surface-2)]" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="surface space-y-3 p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--surface-2)]" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--surface-2)]" />
            <div className="mt-4 h-6 w-24 animate-pulse rounded-full bg-[var(--surface-2)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<IntegrationsSkeleton />}>
      <IntegrationsClient />
    </Suspense>
  );
}
