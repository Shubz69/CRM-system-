"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

type Notification = {
  id: string;
  title?: string | null;
  body?: string | null;
  readAt?: string | null;
  createdAt: string;
  href?: string | null;
  metadata?: { conversationId?: string } | null;
};

export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  async function load() {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const json = await res.json();
      setItems(json.notifications || []);
      setUnread(json.unreadCount || 0);
    } catch {
      // keep previous
    }
  }

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function markAllRead() {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => undefined);
    await load();
  }

  function hrefFor(n: Notification) {
    if (typeof n.href === "string" && n.href.startsWith("/")) return n.href;
    const conversationId = n.metadata?.conversationId;
    if (conversationId) return `/inbox?c=${conversationId}`;
    return "/attention";
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn btn-secondary relative px-2.5 py-2"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-[var(--danger)] px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default bg-transparent"
            aria-label="Close notifications"
            onClick={() => setOpen(false)}
          />
          <div
            className="surface absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
            role="dialog"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && (
                <button type="button" className="text-xs text-[var(--accent)]" onClick={() => void markAllRead()}>
                  Mark all read
                </button>
              )}
            </div>
            <ul className="max-h-80 overflow-y-auto">
              {items.length === 0 && (
                <li className="px-3 py-6 text-sm text-[var(--muted)]">Nothing needs you yet.</li>
              )}
              {items.map((n) => (
                <li key={n.id}>
                  <Link
                    href={hrefFor(n)}
                    className="block px-3 py-2.5 text-sm hover:bg-[var(--surface-2)]"
                    onClick={() => setOpen(false)}
                  >
                    <p className={n.readAt ? "text-[var(--muted)]" : "font-medium"}>
                      {n.title || n.body || "Update"}
                    </p>
                    {n.body && n.title ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{n.body}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] text-[var(--muted)]">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
