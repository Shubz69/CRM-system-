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
  Home,
  Plug,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: "exact" | "prefix";
};

/** Always visible — the product home for a business owner. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/ask", label: "Home", icon: Home, match: "exact" },
];

/**
 * Power-user tools — kept, but behind secondary navigation so new users
 * are not drowning in setup screens on day one.
 */
export const SECONDARY_NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/attention", label: "Needs Attention", icon: AlertTriangle },
  { href: "/agent", label: "AI Agent", icon: Bot },
  { href: "/setup", label: "Setup Assistant", icon: ListChecks },
  { href: "/autopilot", label: "Autopilot", icon: Sparkles },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/qualification", label: "Qualification", icon: ListChecks },
  { href: "/simulator", label: "Simulator", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/settings/go-live", label: "Go Live", icon: ListChecks },
];

/** @deprecated Prefer PRIMARY_NAV + SECONDARY_NAV — kept for command palette. */
export const WORKSPACE_NAV: NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

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

export type OutcomeCard = {
  id: string;
  title: string;
  hint: string;
  /** Prefill for Ask, or href for a first useful action elsewhere. */
  prefill?: string;
  href?: string;
};

export const HOME_OUTCOME_CARDS: OutcomeCard[] = [
  {
    id: "dms",
    title: "Handle my DMs",
    hint: "Connect Instagram and let AI qualify conversations",
    href: "/settings/go-live",
  },
  {
    id: "research",
    title: "Research a topic",
    hint: "Sourced brief with citations you can trust",
    prefill: "Research ",
  },
  {
    id: "trending",
    title: "What's trending",
    hint: "Hooks, themes, and complaints from recent posts",
    prefill: "Social listening on ",
  },
  {
    id: "image",
    title: "Make an image",
    hint: "Upload a reference, edit the prompt, then generate",
    prefill: "Make something like this reference: ",
  },
  {
    id: "content",
    title: "Write content",
    hint: "Posts, emails, or scripts in your voice",
    prefill: "Write content about ",
  },
  {
    id: "reports",
    title: "Show me reports",
    hint: "Daily and weekly results from live data",
    href: "/reports",
  },
];

export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.match === "exact") return pathname === item.href;
  if (pathname === item.href) return true;
  return pathname.startsWith(`${item.href}/`);
}

export function pageTitleFromPath(pathname: string): string {
  const all = [...PRIMARY_NAV, ...SECONDARY_NAV, ...ADMIN_NAV];
  const exact = all.find((i) => i.href === pathname);
  if (exact) return exact.label;
  const nested = all
    .filter((i) => pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (nested) return nested.label;
  if (pathname.startsWith("/account/change-password")) return "Change password";
  return "DM Intelligence";
}
