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
  Target,
  Lightbulb,
  FileText,
  CheckSquare,
  Search,
  Radio,
  TrendingUp,
  MessageSquare,
  Briefcase,
  BarChart3,
  Zap,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: "exact" | "prefix";
};

export type NavSection = {
  id: string;
  label: string;
  hubHref: string;
  items: NavItem[];
  /** Path prefixes that activate this section's subnav (includes leaf routes). */
  pathPrefixes: string[];
};

/** Short primary sidebar — daily use. */
export const CORE_NAV: NavItem[] = [
  { href: "/home", label: "Home", icon: Home, match: "exact" },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/crm", label: "CRM", icon: Briefcase, match: "exact" },
  { href: "/growth", label: "Growth", icon: TrendingUp, match: "exact" },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/analytics", label: "Analytics", icon: BarChart3, match: "exact" },
];

/** Setup cluster in sidebar. */
export const SETUP_NAV: NavItem[] = [
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings, match: "exact" },
];

/** Single Admin entry — nested tools via section subnav. */
export const ADMIN_ENTRY: NavItem = {
  href: "/admin",
  label: "Admin",
  icon: Shield,
  match: "exact",
};

export const CRM_SUBNAV: NavItem[] = [
  { href: "/crm", label: "Overview", icon: Briefcase, match: "exact" },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/deals", label: "Deals", icon: FileBarChart },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
];

export const GROWTH_SUBNAV: NavItem[] = [
  { href: "/growth", label: "Overview", icon: TrendingUp, match: "exact" },
  { href: "/opportunities", label: "Opportunities", icon: Lightbulb },
  { href: "/research", label: "Research", icon: Search },
  { href: "/business-context", label: "Business Profile", icon: Building2 },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/social-intelligence", label: "Social Trends", icon: Radio },
];

export const ANALYTICS_SUBNAV: NavItem[] = [
  { href: "/analytics", label: "Overview", icon: BarChart3, match: "exact" },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/learning", label: "Learning", icon: FlaskConical },
];

export const ADMIN_SUBNAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: Shield, match: "exact" },
  { href: "/admin/ai-ops", label: "AI Ops", icon: Activity },
  { href: "/admin/workspaces", label: "Workspaces", icon: Building2 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/usage", label: "AI Usage", icon: Cpu },
  { href: "/admin/health", label: "System Health", icon: Activity },
  { href: "/admin/webhooks", label: "Webhook Events", icon: Workflow },
  { href: "/admin/failed-jobs", label: "Failed Jobs", icon: AlertTriangle },
  { href: "/admin/audit", label: "Audit Logs", icon: ScrollText },
  { href: "/admin/settings", label: "Global Settings", icon: Settings },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "crm",
    label: "CRM",
    hubHref: "/crm",
    items: CRM_SUBNAV,
    pathPrefixes: ["/crm", "/contacts", "/companies", "/deals", "/pipeline"],
  },
  {
    id: "growth",
    label: "Growth",
    hubHref: "/growth",
    items: GROWTH_SUBNAV,
    pathPrefixes: [
      "/growth",
      "/opportunities",
      "/research",
      "/business-context",
      "/knowledge",
      "/content",
      "/goals",
      "/social-intelligence",
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    hubHref: "/analytics",
    items: ANALYTICS_SUBNAV,
    pathPrefixes: ["/analytics", "/reports", "/insights", "/learning"],
  },
  {
    id: "admin",
    label: "Admin",
    hubHref: "/admin",
    items: ADMIN_SUBNAV,
    pathPrefixes: ["/admin"],
  },
];

/** Power tools — command palette / deep links only (not sidebar). */
export const POWER_TOOLS_NAV: NavItem[] = [
  { href: "/ask", label: "Ask AI", icon: MessageSquare },
  { href: "/attention", label: "Needs Attention", icon: AlertTriangle },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/autopilot", label: "Autopilot", icon: Zap },
  { href: "/qualification", label: "Qualification", icon: ListChecks },
  { href: "/simulator", label: "Simulator", icon: FlaskConical },
  { href: "/agent", label: "AI Behaviour", icon: Bot },
  { href: "/settings/go-live", label: "Go-live checklist", icon: ListChecks },
  { href: "/setup", label: "Setup Assistant", icon: ListChecks },
  { href: "/dashboard", label: "Legacy overview", icon: LayoutDashboard },
];

/** Flat list for command palette search. */
export const WORKSPACE_NAV: NavItem[] = [
  ...CORE_NAV,
  ...SETUP_NAV,
  ...CRM_SUBNAV.filter((i) => i.href !== "/crm"),
  ...GROWTH_SUBNAV.filter((i) => i.href !== "/growth"),
  ...ANALYTICS_SUBNAV.filter((i) => i.href !== "/analytics"),
  ...POWER_TOOLS_NAV,
];

/** @deprecated Alias — admin nested tools. */
export const ADMIN_NAV = ADMIN_SUBNAV;

/** Backward-compatible aliases used by older imports. */
export const PRIMARY_NAV = CORE_NAV;
export const WORK_NAV: NavItem[] = [];
export const SECONDARY_NAV = POWER_TOOLS_NAV;
export const INTELLIGENCE_NAV = GROWTH_SUBNAV;

export type OutcomeCard = {
  id: string;
  title: string;
  hint: string;
  group: "Sales" | "Messaging" | "Research" | "Content" | "Reporting";
  prefill?: string;
  href?: string;
};

/** Guided Ask examples — grouped by outcome. */
export const ASK_OUTCOME_CARDS: OutcomeCard[] = [
  {
    id: "hot-leads",
    title: "What needs my attention?",
    hint: "Handoffs, hot leads, and stalled deals",
    group: "Sales",
    href: "/attention",
  },
  {
    id: "pipeline",
    title: "Summarise my pipeline",
    hint: "Where deals are stuck and what to do next",
    group: "Sales",
    prefill: "Summarise my pipeline and flag stalled deals",
  },
  {
    id: "dms",
    title: "Help me handle DMs",
    hint: "Qualify conversations and suggest replies",
    group: "Messaging",
    prefill: "Help me respond to open Instagram conversations",
  },
  {
    id: "objections",
    title: "Common objections this week",
    hint: "Patterns from live conversations",
    group: "Messaging",
    prefill: "What objections came up in recent conversations?",
  },
  {
    id: "research",
    title: "Research a topic",
    hint: "Sourced brief with citations",
    group: "Research",
    prefill: "Research ",
  },
  {
    id: "trending",
    title: "What's trending",
    hint: "Hooks and themes from recent posts",
    group: "Research",
    prefill: "Social listening on ",
  },
  {
    id: "content",
    title: "Write content",
    hint: "Posts or scripts in your voice",
    group: "Content",
    prefill: "Write content about ",
  },
  {
    id: "image",
    title: "Make an image",
    hint: "Generate from a reference or brief",
    group: "Content",
    prefill: "Make something like this reference: ",
  },
  {
    id: "reports",
    title: "Show me results",
    hint: "Meetings, replies, and conversion",
    group: "Reporting",
    href: "/reports",
  },
  {
    id: "weekly",
    title: "Weekly performance",
    hint: "What moved and what stalled",
    group: "Reporting",
    prefill: "Give me a weekly performance briefing",
  },
];

/** @deprecated Prefer ASK_OUTCOME_CARDS */
export const HOME_OUTCOME_CARDS = ASK_OUTCOME_CARDS;

export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.match === "exact") return pathname === item.href;
  if (pathname === item.href) return true;
  return pathname.startsWith(`${item.href}/`);
}

export function sectionForPath(pathname: string): NavSection | null {
  return (
    NAV_SECTIONS.find((section) =>
      section.pathPrefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      ),
    ) ?? null
  );
}

export function pageTitleFromPath(pathname: string): string {
  if (pathname === "/home") return "Home";
  if (pathname === "/ask") return "Ask";

  const all = [
    ...CORE_NAV,
    ...SETUP_NAV,
    ...CRM_SUBNAV,
    ...GROWTH_SUBNAV,
    ...ANALYTICS_SUBNAV,
    ...ADMIN_SUBNAV,
    ...POWER_TOOLS_NAV,
  ];
  const exact = all.find((i) => i.href === pathname);
  if (exact) return exact.label;
  const nested = all
    .filter((i) => pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (nested) return nested.label;
  if (pathname.startsWith("/account/change-password")) return "Change password";
  return "Agent Desk";
}
