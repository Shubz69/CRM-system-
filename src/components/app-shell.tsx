"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Inbox,
  KanbanSquare,
  Users,
  BookOpen,
  Bot,
  Sparkles,
  Workflow,
  FileBarChart,
  Settings,
  FlaskConical,
  ListChecks,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/agent", label: "AI Agent", icon: Bot },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/qualification", label: "Qualification", icon: ListChecks },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/integrations", label: "Integrations", icon: Settings },
  { href: "/simulator", label: "Simulator", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings },
];

const ADMIN_NAV = [
  { href: "/admin", label: "Platform Overview", icon: Shield },
  { href: "/admin/workspaces", label: "Workspaces", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/usage", label: "AI Usage", icon: Bot },
  { href: "/admin/health", label: "System Health", icon: Sparkles },
  { href: "/admin/webhooks", label: "Webhook Events", icon: Workflow },
  { href: "/admin/failed-jobs", label: "Failed Jobs", icon: ListChecks },
  { href: "/admin/audit", label: "Audit Logs", icon: FileBarChart },
  { href: "/admin/settings", label: "Global Settings", icon: Settings },
];

type OrgOption = {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
};

export function AppShell({
  children,
  orgName,
  userName,
  isPlatformAdmin,
}: {
  children: React.ReactNode;
  orgName?: string;
  userName?: string | null;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const { data: session, update } = useSession();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const isSuperAdmin =
    Boolean(isPlatformAdmin) ||
    Boolean(session?.user?.isPlatformAdmin) ||
    session?.user?.role === "SUPER_ADMIN" ||
    session?.user?.role === "OWNER";

  useEffect(() => {
    fetch("/api/organisations")
      .then(async (r) => {
        if (!r.ok) return;
        const j = await r.json();
        setOrgs(j.organisations || []);
      })
      .catch(() => undefined);
  }, [session?.user?.organisationId]);

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

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="bg-[var(--sidebar)] text-[var(--sidebar-text)] lg:min-h-screen">
        <div className="border-b border-white/10 px-5 py-5">
          <p className="font-[family-name:var(--font-fraunces)] text-2xl text-white">
            DM Intelligence
          </p>
          {orgs.length > 1 ? (
            <label className="mt-3 block text-xs text-teal-100/70">
              Organisation
              <select
                className="mt-1 w-full rounded-xl border border-white/15 bg-white/10 px-2 py-1.5 text-sm text-white"
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
          ) : (
            <p className="mt-1 text-sm text-teal-100/70">{activeName}</p>
          )}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-4 lg:flex-col">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition",
                  active
                    ? "bg-white/12 text-white"
                    : "text-teal-50/70 hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
          {isSuperAdmin && (
            <>
              <p className="mt-4 px-3 text-[10px] uppercase tracking-[0.18em] text-teal-200/50">
                Super Admin
              </p>
              {ADMIN_NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition",
                      active
                        ? "bg-white/12 text-white"
                        : "text-teal-50/70 hover:bg-white/8 hover:text-white",
                    )}
                  >
                    <Icon size={16} />
                    {item.label}
                  </Link>
                );
              })}
            </>
          )}
        </nav>
        <div className="hidden border-t border-white/10 px-5 py-4 text-sm text-teal-100/70 lg:block">
          Signed in as {userName || session?.user?.name || "User"}
        </div>
      </aside>
      <main className="animate-rise min-w-0 p-4 md:p-6 lg:p-8">{children}</main>
    </div>
  );
}
