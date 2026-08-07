"use client";

import { SessionProvider } from "next-auth/react";
import { CommandPalette } from "@/components/command-palette";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <CommandPalette />
    </SessionProvider>
  );
}
