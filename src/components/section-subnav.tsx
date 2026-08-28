"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import type { NavItem } from "@/lib/navigation";
import { isNavActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Section sub-navigation with readable active states.
 * Desktop: full horizontal tabs. Mobile: compact select switcher.
 */
export function SectionSubnav({
  items,
  label,
}: {
  items: NavItem[];
  label?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const activeItem = useMemo(
    () => items.find((item) => isNavActive(pathname, item)) ?? items[0],
    [items, pathname],
  );

  return (
    <div className="border-b border-[var(--border)]/70 bg-[color-mix(in_oklab,var(--surface)_94%,transparent)] px-4 md:px-6">
      {/* Narrow / tablet: section switcher — never clip tab labels */}
      <div className="flex items-center gap-3 py-2.5 lg:hidden">
        {label ? (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            {label}
          </span>
        ) : null}
        <label className="sr-only" htmlFor="section-subnav-switcher">
          {label ? `${label} section` : "Section"}
        </label>
        <select
          id="section-subnav-switcher"
          className="input min-w-0 flex-1 py-2 text-sm font-medium text-[var(--foreground)]"
          value={activeItem?.href ?? ""}
          onChange={(e) => router.push(e.target.value)}
          aria-label={label ? `${label} navigation` : "Section navigation"}
        >
          {items.map((item) => (
            <option key={item.href} value={item.href}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop / large tablet: full readable tabs */}
      <nav
        className="hidden items-center gap-1 overflow-x-auto py-2 lg:flex"
        aria-label={label ? `${label} sections` : "Section navigation"}
      >
        {label ? (
          <span className="mr-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            {label}
          </span>
        ) : null}
        {items.map((item) => {
          const active = isNavActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : "false"}
              className={cn(
                "focus-ring shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                active
                  ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_-2px_0_0_var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
