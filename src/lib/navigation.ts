import type { LucideIcon } from "lucide-react";
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
  Activity,
  AlertTriangle,
  ScrollText,
  Building2,
  Cpu,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: "exact" | "prefix";
};

export const WORKSPACE_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/attention", label: "Needs Attention", icon: AlertTriangle },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/agent", label: "AI Agent", icon: Bot },
  { href: "/autopilot", label: "Autopilot", icon: Sparkles },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/qualification", label: "Qualification", icon: ListChecks },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/integrations", label: "Integrations", icon: Settings },
  { href: "/simulator", label: "Simulator", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/settings/go-live", label: "Go Live", icon: ListChecks },
];

export const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Platform Overview", icon: Shield, match: "exact" },
  { href: "/admin/workspaces", label: "Workspaces", icon: Building2 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/usage", label: "AI Usage", icon: Cpu },
  { href: "/admin/health", label: "System Health", icon: Activity },
  { href: "/admin/webhooks", label: "Webhook Events", icon: Workflow },
  { href: "/admin/failed-jobs", label: "Failed Jobs", icon: AlertTriangle },
  { href: "/admin/audit", label: "Audit Logs", icon: ScrollText },
  { href: "/admin/settings", label: "Global Settings", icon: Settings },
];

export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.match === "exact") return pathname === item.href;
  if (pathname === item.href) return true;
  return pathname.startsWith(`${item.href}/`);
}

export function pageTitleFromPath(pathname: string): string {
  const all = [...WORKSPACE_NAV, ...ADMIN_NAV];
  const exact = all.find((i) => i.href === pathname);
  if (exact) return exact.label;
  const nested = all
    .filter((i) => pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (nested) return nested.label;
  if (pathname.startsWith("/account/change-password")) return "Change password";
  return "DM Intelligence";
}
