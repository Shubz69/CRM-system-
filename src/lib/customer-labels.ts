/**
 * Customer-facing labels for backend enums/keys.
 * Keep raw keys for API calls — only translate at the UI edge.
 */

const KPI_LABELS: Record<string, string> = {
  open_pipeline_cents: "Open pipeline value",
  won_revenue_cents: "Won revenue",
  qualified_lead_count: "Qualified leads",
  booked_meeting_count: "Meetings booked",
  lead_conversion_rate: "Lead conversion rate",
};

const UNIT_LABELS: Record<string, string> = {
  GBP_CENTS: "£",
  USD_CENTS: "$",
  COUNT: "count",
  RATE: "%",
  PERCENT: "%",
};

const STATUS_LABELS: Record<string, string> = {
  RECONCILIATION_REQUIRED: "Needs confirmation",
  WAITING_APPROVAL: "Needs approval",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DETECTED: "New",
  REVIEWED: "Reviewed",
  ACCEPTED: "Accepted",
  DISMISSED: "Dismissed",
  OPEN: "Open",
  WON: "Won",
  LOST: "Lost",
  ABANDONED: "Abandoned",
  DRAFT: "Draft",
  READY: "Ready",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  UNKNOWN: "Unknown",
  CONFIRMED: "Confirmed",
  RUNNING: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  BLOCKED: "Blocked",
  PAUSED: "Paused",
  ACTIVE: "Active",
  SUGGESTED: "Suggested",
};

const TREND_STAGE_LABELS: Record<string, string> = {
  EMERGING: "Emerging",
  GROWING: "Growing quickly",
  BREAKING_OUT: "Breaking out",
  MATURE: "Mature",
  SATURATED: "Saturated",
  DECLINING: "Declining",
};

const ATTRIBUTION_LABELS: Record<string, string> = {
  DIRECT: "Direct",
  CONTRIBUTED: "Contributed",
  UNKNOWN: "Not yet attributed",
};

export function kpiLabel(key: string): string {
  return KPI_LABELS[key] ?? humanizeKey(key);
}

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return STATUS_LABELS[status] ?? humanizeKey(status);
}

export function trendStageLabel(stage: string | null | undefined): string {
  if (!stage) return "Unknown";
  return TREND_STAGE_LABELS[stage] ?? humanizeKey(stage);
}

export function attributionLabel(value: string | null | undefined): string {
  if (!value) return ATTRIBUTION_LABELS.UNKNOWN;
  return ATTRIBUTION_LABELS[value] ?? humanizeKey(value);
}

/** Format cents units as currency for display. */
export function formatKpiValue(value: number, unit: string): string {
  if (unit === "GBP_CENTS" || unit === "USD_CENTS") {
    const symbol = unit === "USD_CENTS" ? "$" : "£";
    return `${symbol}${(value / 100).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }
  if (unit === "RATE" || unit === "PERCENT") {
    return `${(value * (unit === "RATE" ? 100 : 1)).toFixed(1)}%`;
  }
  return value.toLocaleString();
}

export function publishStatusMessage(status: string): string {
  if (status === "RECONCILIATION_REQUIRED") {
    return "We couldn't confirm whether the platform received this post. Review before retrying.";
  }
  return statusLabel(status);
}

function humanizeKey(raw: string): string {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const KPI_OPTIONS = Object.entries(KPI_LABELS).map(([value, label]) => ({
  value,
  label,
}));
