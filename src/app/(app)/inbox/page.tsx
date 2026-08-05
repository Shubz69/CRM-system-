import { Suspense } from "react";
import InboxPage from "./inbox-client";

export default function Page() {
  return (
    <Suspense fallback={<div className="surface p-6">Loading inbox…</div>}>
      <InboxPage />
    </Suspense>
  );
}
