"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { ChevronsLeft, ChevronsRight, LogOut, Search } from "lucide-react";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { openCommandPalette } from "@/components/command-palette";
import { NotificationsMenu } from "@/components/notifications-menu";
import { SectionSubnav } from "@/components/section-subnav";
import {
  ADMIN_ENTRY,
  CORE_NAV,
  SETUP_NAV,
  isNavActive,
  pageTitleFromPath,
  sectionForPath,
  type NavItem,
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
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const active = isNavActive(pathname, item) || sectionActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
        className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-150",
        active
          ? "bg-white/12 text-white shadow-[inset_3px_0_0_0_var(--accent)]"
          : "text-white/60 hover:bg-white/7 hover:text-white/95",
        collapsed && "justify-center px-2",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon
        size={18}
        strokeWidth={active ? 2.25 : 1.75}
        className={cn("shrink-0", active ? "text-[var(--hero-mist)]" : "text-white/55 group-hover:text-white/80")}
        aria-hidden
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

/** Highlight CRM/Growth/Analytics hub when a leaf route in that section is active. */
function sectionActive(pathname: string, item: NavItem): boolean {
  const section = sectionForPath(pathname);
  if (!section) return false;
  if (item.href === "/crm" && section.id === "crm") return true;
  if (item.href === "/growth" && section.id === "growth") return true;
  if (item.href === "/analytics" && section.id === "analytics") return true;
  if (item.href === "/admin" && section.id === "admin") return true;
  return false;
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
  navigationLocked?: boolean;
}) {
  const pathname = usePathname();
  const { data: session, update } = useSession();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const locked = navigationLocked || Boolean(session?.user?.mustChangePassword);

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

  async function switchOrg(organisationId: string) {
    try {
      const res = await fetch("/api/session/organisation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organisationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Switch failed");
      // Other open tabs must refresh before mutating — displayed org must match target.
      try {
        const bc = new BroadcastChannel("agent-desk-workspace");
        bc.postMessage({
          type: "org-changed",
          organisationId,
          organisationName: json.organisationName,
        });
        bc.close();
      } catch {
        /* BroadcastChannel unavailable — this tab still reloads */
      }
      await update({ organisationId });
      toast.success(`Switched to ${json.organisationName}`);
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch organisation");
    }
  }

  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("agent-desk-workspace");
      bc.onmessage = (ev) => {
        const data = ev.data as { type?: string; organisationId?: string; organisationName?: string };
        if (data?.type !== "org-changed" || !data.organisationId) return;
        if (data.organisationId === session?.user?.organisationId) return;
        toast.message(
          `Workspace changed to ${data.organisationName || "another organisation"} in another tab — refreshing so actions stay on the right account.`,
        );
        window.location.reload();
      };
    } catch {
      bc = null;
    }
    return () => {
      try {
        bc?.close();
      } catch {
        /* ignore */
      }
    };
  }, [session?.user?.organisationId]);

  const activeName =
    orgs.find((o) => o.isActive)?.name ||
    session?.user?.organisationName ||
    orgName ||
    "Workspace";

  const title = useMemo(() => pageTitleFromPath(pathname), [pathname]);
  const activeSection = useMemo(() => {
    const section = sectionForPath(pathname);
    if (section?.id === "admin" && !isSuperAdmin) return null;
    return section;
  }, [pathname, isSuperAdmin]);
  const isHome = pathname === "/home";

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
          collapsed ? "lg:w-[84px]" : "lg:w-[248px]",
          mobileOpen ? "fixed inset-y-0 left-0 w-[248px]" : "hidden lg:flex lg:flex-col",
        )}
      >
        <div className="border-b border-white/10 px-4 py-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-fraunces)] text-xl text-white">
                {collapsed ? "AD" : "Agent Desk"}
              </p>
              {!collapsed && (
                <p className="mt-1 truncate text-xs text-white/50">{activeName}</p>
              )}
            </div>
            <button
              type="button"
              className="hidden rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white lg:inline-flex"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            </button>
          </div>
          {!collapsed && orgs.length > 1 && (
            <label className="mt-3 block text-[11px] uppercase tracking-[0.14em] text-white/40">
              Active workspace
              <select
                className="mt-1.5 w-full rounded-xl border border-white/12 bg-white/8 px-2.5 py-2 text-sm text-white outline-none focus:border-[var(--accent)]"
                value={session?.user?.organisationId || ""}
                onChange={(e) => switchOrg(e.target.value)}
                aria-label="Switch active workspace"
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
          {!collapsed && (
            <p className="mb-1 px-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/40">
              Core
            </p>
          )}
          {CORE_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              collapsed={collapsed}
              onNavigate={() => setMobileOpen(false)}
            />
          ))}

          {!collapsed && (
            <p className="mt-5 mb-1 px-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/40">
              Setup
            </p>
          )}
          {collapsed && <div className="my-3 border-t border-white/10" />}
          {SETUP_NAV.map((item) => (
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
                <p className="mt-5 mb-1 px-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/35">
                  Admin
                </p>
              )}
              {collapsed && <div className="my-3 border-t border-white/10" />}
              <NavLink
                item={ADMIN_ENTRY}
                pathname={pathname}
                collapsed={collapsed}
                onNavigate={() => setMobileOpen(false)}
              />
            </>
          )}
        </nav>

        <div className="border-t border-white/10 px-3 py-4">
          {!collapsed ? (
            <div className="rounded-xl bg-white/6 px-3 py-3">
              <p className="truncate text-sm font-medium text-white">
                {userName || session?.user?.name || "User"}
              </p>
              <p className="truncate text-xs text-white/45">{session?.user?.email}</p>
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-2 text-xs text-white/60 hover:text-white"
                onClick={() => signOut({ callbackUrl: "/login" })}
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mx-auto flex rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
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
            <div className="lg:hidden">
              <button
                type="button"
                className="btn btn-secondary px-2.5 py-2"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation menu"
              >
                Menu
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <p className="caption">{activeName}</p>
              <h1 className="truncate font-[family-name:var(--font-fraunces)] text-xl tracking-tight text-[var(--foreground)] md:text-2xl">
                {isHome ? "Today" : title}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="focus-ring relative hidden w-full max-w-64 text-left sm:block md:w-64"
                onClick={() => openCommandPalette()}
                aria-label="Open search (Ctrl or Cmd+K)"
              >
                <Search
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-[var(--muted)]"
                  aria-hidden
                />
                <span className="input has-leading-icon flex w-full items-center py-2 text-sm text-[var(--muted)]">
                  Search Agent Desk…
                  <kbd className="ml-auto hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted)] md:inline">
                    ⌘K
                  </kbd>
                </span>
              </button>
              <div className="sm:hidden">
                <button
                  type="button"
                  className="btn btn-secondary px-2.5 py-2"
                  onClick={() => openCommandPalette()}
                  aria-label="Open search"
                >
                  <Search size={16} />
                </button>
              </div>
              <NotificationsMenu />
            </div>
          </div>
        </header>
        {activeSection ? (
          <SectionSubnav items={activeSection.items} label={activeSection.label} />
        ) : null}
        <main className="animate-rise min-w-0 flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
