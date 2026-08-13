"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type AttentionItem = {
  id: string;
  type: string;
  title: string;
  detail: string;
  href: string;
  severity: "high" | "medium";
  createdAt: string;
};

export default function NeedsAttentionPage() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/attention")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setItems(j.items || []);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Needs Attention</h1>
        <p className="mt-1 text-[var(--muted)]">
          Exception queue — everything else is handled by Autopilot.
        </p>
      </div>

      {loading ? (
        <div className="surface p-6 text-sm text-[var(--muted)]">Loading queue…</div>
      ) : items.length === 0 ? (
        <div className="surface p-8 text-center">
          <p className="font-[family-name:var(--font-fraunces)] text-2xl">All clear</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Your AI operator has no exceptions waiting. Check the dashboard for activity.
          </p>
          <Link href="/ask" className="btn btn-primary mt-4">
            Go to Home
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="surface surface-interactive flex flex-wrap items-start justify-between gap-3 p-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`badge ${item.severity === "high" ? "badge-warn" : ""}`}
                    >
                      {item.type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-2 font-medium">{item.title}</p>
                  <p className="text-sm text-[var(--muted)]">{item.detail}</p>
                </div>
                <span className="text-xs text-[var(--muted)]">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
