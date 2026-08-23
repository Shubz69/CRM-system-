"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_NAV, ADMIN_NAV } from "@/lib/navigation";
import { useSession } from "next-auth/react";

export const OPEN_COMMAND_PALETTE_EVENT = "dm-open-command-palette";

export function openCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

type PaletteItem = {
  label: string;
  href: string;
  hint?: string;
};

export function CommandPalette() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const isAdmin =
    session?.user?.isPlatformAdmin || session?.user?.role === "SUPER_ADMIN";

  const items = useMemo(() => {
    const base: PaletteItem[] = [...WORKSPACE_NAV, ...(isAdmin ? ADMIN_NAV : [])].map(
      (i) => ({
        label: i.label,
        href: i.href,
      }),
    );
    const actions: PaletteItem[] = [
      { label: "Test conversation (Simulator)", href: "/simulator" },
      { label: "Upload knowledge", href: "/knowledge" },
      { label: "Create automation", href: "/automations" },
      { label: "Open inbox", href: "/inbox" },
      { label: "Needs attention", href: "/attention" },
      { label: "Go-live checklist", href: "/settings/go-live" },
      { label: "Setup Assistant", href: "/setup" },
    ];
    if (isAdmin) {
      actions.push({ label: "AI Ops console", href: "/admin/ai-ops" });
    }

    const q = query.trim();
    const qLower = q.toLowerCase();

    // Universal Ask: any query that looks like a question or starts with ask:
    const askItems: PaletteItem[] = [];
    if (q.length >= 2) {
      const askText = qLower.startsWith("ask:") ? q.slice(4).trim() : q;
      if (askText) {
        askItems.push({
          label: `Ask: ${askText}`,
          href: `/ask?q=${encodeURIComponent(askText)}`,
          hint: "Start on Home with this request",
        });
      }
    } else {
      askItems.push({
        label: "Ask on Home…",
        href: "/ask",
        hint: "Type a request or navigate",
      });
    }

    const all = [...askItems, ...actions, ...base];
    if (!qLower || qLower.startsWith("ask:")) {
      return all.slice(0, 14);
    }
    return all
      .filter(
        (i) =>
          i.label.toLowerCase().includes(qLower) ||
          i.href.toLowerCase().includes(qLower) ||
          i.label.startsWith("Ask:"),
      )
      .slice(0, 14);
  }, [isAdmin, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
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
          placeholder="Ask something, or jump to a page…"
          aria-label="Ask or search pages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && items[0]) {
              e.preventDefault();
              setOpen(false);
              setQuery("");
              router.push(items[0].href);
            }
          }}
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
                <span className="block font-medium">{item.label}</span>
                {item.hint && (
                  <span className="block text-xs text-[var(--muted)]">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
          Esc to close · Enter opens top result · prefix with ask: for Home
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
