"use client";

import { SessionProvider } from "next-auth/react";
import { CommandPalette } from "@/components/command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider
      // Avoid noisy /api/auth/session churn; JWT is already in the cookie.
      refetchOnWindowFocus={false}
      refetchInterval={0}
    >
      {children}
      <CommandPalette />
    </SessionProvider>
  );
}
