"use client";

import { useEffect, useState } from "react";
import {
  isWorkspaceContextReady,
  subscribeWorkspaceContextReady,
} from "@/lib/workspace-client";

/** True once this document has frozen authoritative org+revision. */
export function useWorkspaceReady() {
  const [ready, setReady] = useState(() => isWorkspaceContextReady());
  useEffect(() => {
    if (isWorkspaceContextReady()) {
      setReady(true);
      return;
    }
    return subscribeWorkspaceContextReady(() => setReady(true));
  }, []);
  return ready;
}
