"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { Bell, ChevronsLeft, ChevronsRight, ChevronDown, LogOut, Search } from "lucide-react";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { openCommandPalette } from "@/components/command-palette";
import {
  ADMIN_NAV,
  PRIMARY_NAV,
  SECONDARY_NAV,
  isNavActive,
  pageTitleFromPath,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type OrgOption = {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
};

function NavLink({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: (typeof PRIMARY_NAV)[number];
  pathname: string;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const active = isNavActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition duration-150",
        active
          ? "bg-white/12 text-white shadow-[inset_3px_0_0_0_var(--accent)]"
          : "text-teal-50/70 hover:bg-white/8 hover:text-white",
        collapsed && "justify-center px-2",
      )}
    >
      <Icon size={17} className={cn(active ? "text-[var(--hero-mist)]" : "")} />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

export function AppShell({
  children,
  orgName,
  userName,
  isPlatformAdmin,
  navigationLocked = false,
}: {
  children: React.ReactNode;
  orgName?: string;
  userName?: string | null;
  isPlatformAdmin?: boolean;
  /** When true (forced password change), hide app nav and only show the lock screen content. */
  navigationLocked?: boolean;
}) {
  const pathname = usePathname();
  const { data: session, update } = useSession();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(() =>
    SECONDARY_NAV.some((item) => isNavActive(pathname, item)),
  );

  const locked =
    navigationLocked || Boolean(session?.user?.mustChangePassword);

  const isSuperAdmin =
    Boolean(isPlatformAdmin) ||
    Boolean(session?.user?.isPlatformAdmin) ||
    session?.user?.role === "SUPER_ADMIN";

  useEffect(() => {
    if (locked) return;
    fetch("/api/organisations")
      .then(async (r) => {
        if (!r.ok) return;
        const j = await r.json();
        setOrgs(j.organisations || []);
      })
      .catch(() => undefined);
  }, [session?.user?.organisationId, locked]);

  useEffect(() => {
    if (SECONDARY_NAV.some((item) => isNavActive(pathname, item))) {
      setToolsOpen(true);
    }
  }, [pathname]);

  async function switchOrg(organisationId: string) {
    try {
      const res = await fetch("/api/session/organisation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organisationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Switch failed");
      await update({ organisationId });
      toast.success(`Switched to ${json.organisationName}`);
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch organisation");
    }
  }

  const activeName =
    orgs.find((o) => o.isActive)?.name ||
    session?.user?.organisationName ||
    orgName ||
    "CRM";

  const title = useMemo(() => pageTitleFromPath(pathname), [pathname]);
  const isHome = pathname === "/ask";

  if (locked) {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <div className="pointer-events-none absolute inset-0 app-atmosphere" aria-hidden />
        <div className="relative mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
          <div className="mb-6 text-center">
            <p className="font-[family-name:var(--font-fraunces)] text-3xl text-[var(--sidebar)]">
              Agent Desk
            </p>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Security checkpoint — update your password to unlock the workspace.
            </p>
          </div>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen lg:grid lg:grid-cols-[auto_1fr]">
      <div className="pointer-events-none absolute inset-0 app-atmosphere" aria-hidden />

      <aside
        className={cn(
          "relative z-20 border-r border-white/8 bg-[var(--sidebar)] text-[var(--sidebar-text)] transition-[width] duration-200 lg:min-h-screen",
          collapsed ? "lg:w-[84px]" : "lg:w-[272px]",
          mobileOpen ? "fixed inset-y-0 left-0 w-[272px]" : "hidden lg:flex lg:flex-col",
        )}
      >
        <div className="border-b border-white/10 px-4 py-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-fraunces)] text-xl text-white">
                {collapsed ? "AD" : "Agent Desk"}
              </p>
              {!collapsed && (
                <p className="mt-1 truncate text-xs text-teal-100/60">{activeName}</p>
              )}
            </div>
            <button
              type="button"
              className="hidden rounded-lg p-1.5 text-teal-100/70 hover:bg-white/10 hover:text-white lg:inline-flex"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            </button>
          </div>
          {!collapsed && orgs.length > 1 && (
            <label className="mt-3 block text-[11px] uppercase tracking-[0.14em] text-teal-100/50">
              Workspace
              <select
                className="mt-1.5 w-full rounded-xl border border-white/12 bg-white/8 px-2.5 py-2 text-sm text-white outline-none focus:border-[var(--accent)]"
                value={session?.user?.organisationId || ""}
                onChange={(e) => switchOrg(e.target.value)}
                aria-label="Switch organisation"
              >
                {orgs.map((org) => (
                  <option key={org.id} value={org.id} className="text-black">
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              collapsed={collapsed}
              onNavigate={() => setMobileOpen(false)}
            />
          ))}

          {!collapsed ? (
            <button
              type="button"
              className="mt-4 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-teal-200/50 hover:bg-white/6 hover:text-teal-100/80"
              onClick={() => setToolsOpen((v) => !v)}
              aria-expanded={toolsOpen}
            >
              <span>More tools</span>
              <ChevronDown
                size={14}
                className={cn("transition-transform", toolsOpen && "rotate-180")}
              />
            </button>
          ) : (
            <div className="my-3 border-t border-white/10" />
          )}

          {(collapsed || toolsOpen) &&
            SECONDARY_NAV.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                collapsed={collapsed}
                onNavigate={() => setMobileOpen(false)}
              />
            ))}

          {isSuperAdmin && (
            <>
              {!collapsed && (
                <p className="mt-5 px-2 pb-2 text-[10px] uppercase tracking-[0.18em] text-teal-200/40">
                  Admin
                </p>
              )}
              {collapsed && <div className="my-3 border-t border-white/10" />}
              {ADMIN_NAV.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  collapsed={collapsed}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
            </>
          )}
        </nav>

        <div className="border-t border-white/10 px-3 py-4">
          {!collapsed ? (
            <div className="rounded-xl bg-white/6 px-3 py-3">
              <p className="truncate text-sm font-medium text-white">
                {userName || session?.user?.name || "User"}
              </p>
              <p className="truncate text-xs text-teal-100/55">{session?.user?.email}</p>
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-2 text-xs text-teal-100/70 hover:text-white"
                onClick={() => signOut({ callbackUrl: "/login" })}
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mx-auto flex rounded-lg p-2 text-teal-100/70 hover:bg-white/10 hover:text-white"
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-10 bg-black/40 lg:hidden"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className="relative z-0 flex min-w-0 flex-col">
        <ImpersonationBanner />
        <header className="sticky top-0 z-10 border-b border-[var(--border)]/70 bg-[color-mix(in_oklab,var(--surface)_88%,transparent)] px-4 py-3 backdrop-blur-md md:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-secondary px-2.5 py-2 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              Menu
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
                {activeName}
              </p>
              {!isHome && (
                <h1 className="truncate font-[family-name:var(--font-fraunces)] text-xl text-[var(--foreground)] md:text-2xl">
                  {title}
                </h1>
              )}
              {isHome && (
                <p className="truncate font-[family-name:var(--font-fraunces)] text-xl text-[var(--foreground)] md:text-2xl">
                  What do you need?
                </p>
              )}
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <button
                type="button"
                className="relative w-56 text-left"
                onClick={() => openCommandPalette()}
                aria-label="Open search (Ctrl or Cmd+K)"
              >
                <Search
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-[var(--muted)]"
                  aria-hidden
                />
                <span className="input has-leading-icon flex w-full items-center py-2 text-sm text-[var(--muted)]">
                  Search…
                  <kbd className="ml-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)]">
                    ⌘K
                  </kbd>
                </span>
              </button>
              <button type="button" className="btn btn-secondary px-2.5 py-2" aria-label="Notifications">
                <Bell size={16} />
              </button>
            </div>
          </div>
        </header>
        <main className="animate-rise min-w-0 flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
