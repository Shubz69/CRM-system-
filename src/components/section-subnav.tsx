"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/navigation";
import { isNavActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function SectionSubnav({
  items,
  label,
}: {
  items: NavItem[];
  label?: string;
}) {
  const pathname = usePathname();

  return (
    <div className="border-b border-[var(--border)]/60 bg-[color-mix(in_oklab,var(--surface)_92%,transparent)] px-4 md:px-6">
      <div className="flex items-center gap-2 overflow-x-auto py-2.5">
        {label ? (
          <span className="mr-1 shrink-0 text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">
            {label}
          </span>
        ) : null}
        {items.map((item) => {
          const active = isNavActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-sm transition",
                active
                  ? "bg-[var(--sidebar)] text-white"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
