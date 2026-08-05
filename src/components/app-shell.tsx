"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/agent", label: "AI Agent", icon: Bot },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/simulator", label: "Simulator", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({
  children,
  orgName,
  userName,
}: {
  children: React.ReactNode;
  orgName?: string;
  userName?: string | null;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="bg-[var(--sidebar)] text-[var(--sidebar-text)] lg:min-h-screen">
        <div className="border-b border-white/10 px-5 py-5">
          <p className="text-xs uppercase tracking-[0.18em] text-emerald-200/70">Product</p>
          <h1 className="mt-1 font-[family-name:var(--font-fraunces)] text-2xl text-white">
            DM Intelligence
          </h1>
          <p className="mt-1 text-sm text-emerald-100/70">{orgName || "CRM"}</p>
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
                    : "text-emerald-50/70 hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden border-t border-white/10 px-5 py-4 text-sm text-emerald-100/70 lg:block">
          Signed in as {userName || "User"}
        </div>
      </aside>
      <main className="min-w-0 p-4 md:p-6 lg:p-8">{children}</main>
    </div>
  );
}
