"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_NAV, ADMIN_NAV } from "@/lib/navigation";
import { useSession } from "next-auth/react";

export function CommandPalette() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const isAdmin =
    session?.user?.isPlatformAdmin ||
    session?.user?.role === "SUPER_ADMIN" ||
    session?.user?.role === "OWNER";

  const items = useMemo(() => {
    const base = [...WORKSPACE_NAV, ...(isAdmin ? ADMIN_NAV : [])].map((i) => ({
      label: i.label,
      href: i.href,
    }));
    const actions = [
      { label: "Test conversation (Simulator)", href: "/simulator" },
      { label: "Upload knowledge", href: "/knowledge" },
      { label: "Create automation", href: "/automations" },
      { label: "Open inbox", href: "/inbox" },
    ];
    const all = [...actions, ...base];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 12);
    return all.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 12);
  }, [isAdmin, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-4 pt-[12vh] backdrop-blur-[2px]">
      <div
        className="surface w-full max-w-xl overflow-hidden p-0 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          autoFocus
          className="input rounded-none border-0 border-b border-[var(--border)]"
          placeholder="Search pages and actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="max-h-80 overflow-y-auto p-2">
          {items.length === 0 && (
            <li className="px-3 py-4 text-sm text-[var(--muted)]">No matches</li>
          )}
          {items.map((item) => (
            <li key={`${item.href}-${item.label}`}>
              <button
                type="button"
                className="w-full rounded-xl px-3 py-2.5 text-left text-sm hover:bg-[var(--surface-2)]"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  router.push(item.href);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
          Esc to close · Enter to open
        </p>
      </div>
      <button
        type="button"
        className="absolute inset-0 -z-10 cursor-default"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
      />
    </div>
  );
}
