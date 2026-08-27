import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { ANALYTICS_SUBNAV } from "@/lib/navigation";

export default function AnalyticsHubPage() {
  const items = ANALYTICS_SUBNAV.filter((i) => i.href !== "/analytics");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader description="Outcomes that matter — leads, meetings, conversion, and what is learning." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="surface-interactive flex items-start gap-3 p-5 transition hover:border-[var(--accent)]"
            >
              <span className="rounded-xl bg-[var(--surface-2)] p-2.5 text-[var(--foreground)]">
                <Icon size={18} />
              </span>
              <span>
                <span className="block font-medium text-[var(--foreground)]">{item.label}</span>
                <span className="mt-1 block text-sm text-[var(--muted)]">
                  {analyticsHint(item.href)}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function analyticsHint(href: string): string {
  switch (href) {
    case "/reports":
      return "Daily and weekly results from live workspace data.";
    case "/insights":
      return "Patterns across conversations and performance.";
    case "/learning":
      return "What Agent Desk is learning about your business.";
    default:
      return "Open analytics.";
  }
}
