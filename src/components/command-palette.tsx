"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_NAV, ADMIN_NAV } from "@/lib/navigation";
import { useSession } from "next-auth/react";

export const OPEN_COMMAND_PALETTE_EVENT = "dm-open-command-palette";

export function openCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

type PaletteItem = {
  id: string;
  label: string;
  href: string;
  hint?: string;
  group: "Actions" | "Contacts" | "Companies" | "Deals" | "Conversations" | "Opportunities" | "Pages";
};

type EntityCache = {
  contacts: Array<{ id: string; fullName: string; email?: string | null; instagramUsername?: string | null }>;
  companies: Array<{ id: string; name: string; domain?: string | null }>;
  deals: Array<{ id: string; name: string; status?: string; company?: { name?: string } | null }>;
  conversations: Array<{ id: string; contactName: string; lastMessagePreview?: string | null }>;
  opportunities: Array<{ id: string; title: string; status?: string }>;
};

const EMPTY_CACHE: EntityCache = {
  contacts: [],
  companies: [],
  deals: [],
  conversations: [],
  opportunities: [],
};

export function CommandPalette() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [entities, setEntities] = useState<EntityCache>(EMPTY_CACHE);
  const [loadingEntities, setLoadingEntities] = useState(false);
  const loadedRef = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAdmin =
    session?.user?.isPlatformAdmin || session?.user?.role === "SUPER_ADMIN";

  const loadEntities = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoadingEntities(true);
    try {
      const [contactsRes, companiesRes, dealsRes, convRes, oppRes] = await Promise.all([
        fetch("/api/contacts"),
        fetch("/api/companies"),
        fetch("/api/deals"),
        fetch("/api/conversations"),
        fetch("/api/opportunities"),
      ]);
      const next: EntityCache = { ...EMPTY_CACHE };
      if (contactsRes.ok) {
        const j = await contactsRes.json();
        next.contacts = (j.contacts || []).slice(0, 80);
      }
      if (companiesRes.ok) {
        const j = await companiesRes.json();
        next.companies = (j.companies || []).slice(0, 80);
      }
      if (dealsRes.ok) {
        const j = await dealsRes.json();
        next.deals = (j.deals || []).slice(0, 80);
      }
      if (convRes.ok) {
        const j = await convRes.json();
        next.conversations = (j.conversations || []).slice(0, 80);
      }
      if (oppRes.ok) {
        const j = await oppRes.json();
        next.opportunities = (j.opportunities || []).slice(0, 80);
      }
      setEntities(next);
    } catch {
      loadedRef.current = false;
    } finally {
      setLoadingEntities(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadEntities();
      setActiveIndex(0);
    } else {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open, loadEntities]);

  const items = useMemo(() => {
    const q = query.trim();
    const qLower = q.toLowerCase();
    const result: PaletteItem[] = [];

    const actions: PaletteItem[] = [
      { id: "a-home", label: "Go to Home", href: "/home", group: "Actions", hint: "Command centre" },
      { id: "a-inbox", label: "Go to Inbox", href: "/inbox", group: "Actions" },
      { id: "a-ask", label: "Ask Agent Desk", href: "/ask", group: "Actions", hint: "Guided requests" },
      { id: "a-crm", label: "Open CRM", href: "/crm", group: "Actions" },
      { id: "a-growth", label: "Open Growth", href: "/growth", group: "Actions" },
      { id: "a-attention", label: "Needs attention", href: "/attention", group: "Actions" },
      { id: "a-integrations", label: "Integrations", href: "/integrations", group: "Actions" },
      { id: "a-simulator", label: "Simulate a test conversation", href: "/simulator", group: "Actions" },
    ];
    if (isAdmin) {
      actions.push({ id: "a-admin", label: "Admin overview", href: "/admin", group: "Actions" });
    }

    if (q.length >= 2) {
      const askText = qLower.startsWith("ask:") ? q.slice(4).trim() : q;
      if (askText) {
        result.push({
          id: `ask-${askText}`,
          label: `Ask: ${askText}`,
          href: `/ask?q=${encodeURIComponent(askText)}`,
          hint: "Open Ask with this request",
          group: "Actions",
        });
      }
    }

    const match = (text: string) => !qLower || text.toLowerCase().includes(qLower);

    for (const a of actions) {
      if (match(a.label) || a.label.startsWith("Ask:")) result.push(a);
    }

    for (const c of entities.contacts) {
      const hay = `${c.fullName} ${c.email || ""} ${c.instagramUsername || ""}`;
      if (match(hay)) {
        result.push({
          id: `contact-${c.id}`,
          label: c.fullName || "Unnamed contact",
          href: `/contacts/${c.id}`,
          hint: c.email || c.instagramUsername || "Contact",
          group: "Contacts",
        });
      }
    }

    for (const co of entities.companies) {
      const hay = `${co.name} ${co.domain || ""}`;
      if (match(hay)) {
        result.push({
          id: `company-${co.id}`,
          label: co.name,
          href: `/companies`,
          hint: co.domain || "Company",
          group: "Companies",
        });
      }
    }

    for (const d of entities.deals) {
      const hay = `${d.name} ${d.company?.name || ""} ${d.status || ""}`;
      if (match(hay)) {
        result.push({
          id: `deal-${d.id}`,
          label: d.name,
          href: `/deals`,
          hint: d.company?.name || d.status || "Deal",
          group: "Deals",
        });
      }
    }

    for (const conv of entities.conversations) {
      const hay = `${conv.contactName} ${conv.lastMessagePreview || ""}`;
      if (match(hay)) {
        result.push({
          id: `conv-${conv.id}`,
          label: conv.contactName,
          href: `/inbox?c=${conv.id}`,
          hint: conv.lastMessagePreview?.slice(0, 80) || "Conversation",
          group: "Conversations",
        });
      }
    }

    for (const o of entities.opportunities) {
      if (match(`${o.title} ${o.status || ""}`)) {
        result.push({
          id: `opp-${o.id}`,
          label: o.title,
          href: `/opportunities`,
          hint: o.status || "Opportunity",
          group: "Opportunities",
        });
      }
    }

    const pages = [...WORKSPACE_NAV, ...(isAdmin ? ADMIN_NAV : [])].map(
      (i): PaletteItem => ({
        id: `page-${i.href}`,
        label: i.label,
        href: i.href,
        group: "Pages",
      }),
    );
    for (const p of pages) {
      if (match(p.label) || match(p.href)) result.push(p);
    }

    // Deduplicate by id, keep first
    const seen = new Set<string>();
    const unique = result.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    if (!qLower) {
      return unique.filter((i) => i.group === "Actions" || i.group === "Pages").slice(0, 14);
    }
    return unique.slice(0, 24);
  }, [entities, isAdmin, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

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

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  function go(item: PaletteItem) {
    setOpen(false);
    setQuery("");
    router.push(item.href);
  }

  if (!open) return null;

  const grouped = items.reduce<Record<string, PaletteItem[]>>((acc, item) => {
    (acc[item.group] ||= []).push(item);
    return acc;
  }, {});

  const flat = items;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-4 pt-[10vh] backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="surface w-full max-w-xl overflow-hidden p-0 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Search Agent Desk"
      >
        <input
          ref={inputRef}
          autoFocus
          className="input rounded-none border-0 border-b border-[var(--border)]"
          placeholder="Search Agent Desk…"
          aria-label="Search contacts, deals, conversations, or pages"
          aria-controls="command-palette-results"
          aria-activedescendant={flat[activeIndex] ? `cmd-${flat[activeIndex].id}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && flat[activeIndex]) {
              e.preventDefault();
              go(flat[activeIndex]);
            }
          }}
        />
        <ul
          id="command-palette-results"
          ref={listRef}
          className="max-h-[min(28rem,55vh)] overflow-y-auto p-2"
          role="listbox"
        >
          {flat.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-[var(--muted)]">
              {loadingEntities ? "Searching…" : "No matches. Try a name, deal, or Ask request."}
            </li>
          )}
          {Object.entries(grouped).map(([group, groupItems]) => (
            <li key={group} className="mb-1">
              <p className="caption px-3 py-1.5">{group}</p>
              <ul>
                {groupItems.map((item) => {
                  const idx = flat.indexOf(item);
                  const active = idx === activeIndex;
                  return (
                    <li key={item.id} role="option" aria-selected={active} id={`cmd-${item.id}`}>
                      <button
                        type="button"
                        className={`w-full rounded-xl px-3 py-2.5 text-left text-sm transition ${
                          active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]"
                        }`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => go(item)}
                      >
                        <span className="block font-medium text-[var(--foreground)]">{item.label}</span>
                        {item.hint ? (
                          <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                            {item.hint}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">
          <span>↑↓ navigate · Enter open · Esc close</span>
          <span>⌘K</span>
        </div>
      </div>
      <button
        type="button"
        className="absolute inset-0 -z-10"
        aria-label="Close search"
        onClick={() => setOpen(false)}
      />
    </div>
  );
}
