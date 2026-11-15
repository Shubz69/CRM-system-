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
  IN_REVIEW: "Awaiting approval",
  PENDING: "Pending",
  APPROVED: "Ready",
  REJECTED: "Needs attention",
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
  FAILED: "Needs attention",
  UNKNOWN: "Unknown",
  CONFIRMED: "Confirmed",
  RUNNING: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  BLOCKED: "Blocked",
  PAUSED: "Paused",
  ACTIVE: "Active",
  SUGGESTED: "Suggested",
  known: "Confirmed",
  partial: "Needs review",
  missing: "Missing",
  QUALIFIED: "Qualified",
  DISQUALIFIED: "Not a fit",
  QUALIFYING: "Qualifying",
  UNKNOWN_QUALIFICATION: "Not scored yet",
  UNQUALIFIED: "Not scored yet",
};

/** Map completeness / claim-style statuses to customer language. */
export function profileStateLabel(status: string | null | undefined): string {
  if (!status) return "Missing";
  const key = status.toLowerCase();
  if (key === "known" || key === "confirmed") return "Confirmed";
  if (key === "partial" || key === "observed" || key === "inferred" || key === "needs_review") {
    return "Needs review";
  }
  if (key === "missing") return "Missing";
  return statusLabel(status);
}

export function profileStateTone(
  status: string | null | undefined,
): "success" | "warn" | "muted" {
  const label = profileStateLabel(status);
  if (label === "Confirmed") return "success";
  if (label === "Needs review") return "warn";
  return "muted";
}

/** Knowledge freshness from updatedAt — evidence-based, never invented. */
export function knowledgeFreshness(updatedAt: string | Date | null | undefined): {
  label: "Current" | "May need review" | "Out of date";
  tone: "success" | "warn" | "danger";
} {
  if (!updatedAt) return { label: "May need review", tone: "warn" };
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return { label: "May need review", tone: "warn" };
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (days <= 30) return { label: "Current", tone: "success" };
  if (days <= 90) return { label: "May need review", tone: "warn" };
  return { label: "Out of date", tone: "danger" };
}

/** Content board buckets for the workspace UI. */
export function contentBucket(
  status: string,
): "drafts" | "ready" | "awaiting" | "scheduled" | "published" | "attention" {
  switch (status) {
    case "DRAFT":
      return "drafts";
    case "APPROVED":
    case "READY":
      return "ready";
    case "IN_REVIEW":
    case "WAITING_APPROVAL":
      return "awaiting";
    case "SCHEDULED":
      return "scheduled";
    case "PUBLISHED":
      return "published";
    default:
      return "attention";
  }
}

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

const INTEGRATION_LABELS: Record<string, string> = {
  MANYCHAT: "ManyChat",
  META_INSTAGRAM: "Instagram (Meta)",
  AYRSHARE: "Ayrshare",
  ZERNIO: "Zernio",
  OPENAI: "OpenAI",
  ANTHROPIC: "Anthropic",
  BOOKING: "Booking calendar",
  GOOGLE_SHEETS: "Google Sheets",
  EMAIL: "Email",
  WEBHOOK: "Webhook",
};

/**
 * A deal amount in its own currency: whole amounts without decimals ("£1,200"), others to the
 * penny ("€1,234.50" — rounding it to "€1,235" misstated the deal).
 */
export function formatDealAmount(
  cents: number | null | undefined,
  currency: string | null | undefined,
  locale?: string,
): string {
  if (cents == null) return "—";
  const code = (currency || "GBP").toUpperCase();
  const digits = cents % 100 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(cents / 100);
  } catch {
    return `${code} ${(cents / 100).toFixed(digits)}`;
  }
}

/** "GOOGLE_SHEETS" → "Google Sheets". */
export function integrationLabel(type: string): string {
  return INTEGRATION_LABELS[type] ?? humanizeKey(type);
}

export function unitLabel(unit: string): string {
  const currency = currencyOfUnit(unit);
  return UNIT_LABELS[unit] ?? (currency ? currencySymbol(currency).trim() : unit);
}

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

/** "USD_CENTS" → "USD"; null for units that aren't money. */
export function currencyOfUnit(unit: string | null | undefined): string | null {
  const match = /^([A-Z]{3})_CENTS$/.exec(unit ?? "");
  return match ? match[1]! : null;
}

/** The money KPI unit for a currency: "usd" → "USD_CENTS". */
export function moneyUnitFor(currency: string): string {
  return `${currency.trim().toUpperCase()}_CENTS`;
}

/** "£", "$", "€", or the code followed by a space ("AUD ") for other currencies. */
export function currencySymbol(currency: string): string {
  const code = currency.trim().toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
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

/**
 * KPI unit convention (shared by the calculators, KPI snapshots, targets and the opportunity
 * detectors that compare them):
 * - <CURRENCY>_CENTS (GBP_CENTS, USD_CENTS, EUR_CENTS…) — minor units (pence / cents), e.g.
 *   £5,000 is stored as 500000
 * - RATE — a 0–1 fraction, e.g. 25% is stored as 0.25
 * - PERCENT — 0–100 as typed
 * - COUNT — as typed
 * People type pounds and percentages; convert at the form edge with these helpers.
 */
function isCentsUnit(unit: string): boolean {
  return currencyOfUnit(unit) !== null;
}

/** What a person types (pounds, percent, count) → the stored KPI value. */
export function kpiInputToStored(input: number, unit: string): number {
  if (isCentsUnit(unit)) return Math.round(input * 100);
  if (unit === "RATE") return Number((input / 100).toPrecision(12));
  return input;
}

/** Stored KPI value → what a person types (inverse of kpiInputToStored). */
export function kpiStoredToInput(value: number, unit: string): number {
  if (isCentsUnit(unit)) return value / 100;
  if (unit === "RATE") return Number((normaliseStoredRate(value) * 100).toPrecision(12));
  return value;
}

/** Short hint for the target input ("£", "%", or "" for counts). */
export function kpiInputAffix(unit: string): { prefix: string; suffix: string } {
  const currency = currencyOfUnit(unit);
  if (currency) return { prefix: currencySymbol(currency).trim(), suffix: "" };
  if (unit === "RATE" || unit === "PERCENT") return { prefix: "", suffix: "%" };
  return { prefix: "", suffix: "" };
}

/**
 * RATE targets saved before the form converted percentages were stored as typed (25 for 25%).
 * A real rate can never exceed 1 (100%), so anything above 1 is one of those and is read as a
 * percentage.
 */
function normaliseStoredRate(value: number): number {
  return value > 1 ? value / 100 : value;
}

/** Format a stored KPI value (see convention above) for display. */
export function formatKpiValue(value: number, unit: string): string {
  if (isCentsUnit(unit)) {
    const symbol = currencySymbol(currencyOfUnit(unit)!);
    return `${symbol}${(value / 100).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }
  if (unit === "RATE") {
    return `${(normaliseStoredRate(value) * 100).toFixed(1)}%`;
  }
  if (unit === "PERCENT") {
    return `${value.toFixed(1)}%`;
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

/**
 * Automation triggers that are actually emitted to `runAutomations` today — the single source
 * of truth for the trigger picker, NL compile and API validation. A rule on any other trigger
 * never runs. Emitters:
 * - inbound pipeline: new_inbound_message, lead_replied, contact_opted_out, human_requested,
 *   negative_sentiment, lead_score_changed, lead_qualified, lead_disqualified, booking_link_sent
 * - booking webhook: booking_created, booking_rescheduled, booking_cancelled, booking_updated
 * - domain-event consumer (worker, `domainEventToAutomationTrigger`): lead_created, message_received
 * Keep in sync when adding/removing an emitter.
 */
const TRIGGER_LABELS = {
  lead_created: "A new lead arrives",
  new_inbound_message: "A customer message arrives",
  lead_replied: "A lead replies",
  lead_qualified: "A lead becomes qualified",
  lead_disqualified: "A lead is disqualified",
  lead_score_changed: "A lead's score is updated",
  human_requested: "A lead asks for a person",
  negative_sentiment: "A lead sounds unhappy",
  contact_opted_out: "A contact opts out",
  booking_link_sent: "A booking link is sent",
  booking_created: "A meeting is booked",
  booking_rescheduled: "A meeting is rescheduled",
  booking_cancelled: "A meeting is cancelled",
  booking_updated: "A booking is updated",
  message_received: "A customer message is recorded",
} as const;

export type AutomationTrigger = keyof typeof TRIGGER_LABELS;

/** Every trigger that fires. Options, NL compile and the automations API all derive from this. */
export const AUTOMATION_TRIGGERS = Object.keys(TRIGGER_LABELS) as AutomationTrigger[];

/** Labels for triggers older rules may still store but that are never emitted. */
const LEGACY_TRIGGER_LABELS: Record<string, string> = {
  conversation_updated: "A conversation is updated",
  conversation_inactive: "A conversation goes quiet",
  deal_won: "A deal is won",
  deal_lost: "A deal is lost",
  message_inbound: "A customer message arrives (old trigger)",
};

export function isFiringAutomationTrigger(key: string | null | undefined): boolean {
  return Boolean(key) && Object.prototype.hasOwnProperty.call(TRIGGER_LABELS, key as string);
}

/**
 * Action types with an executor in `executeAction` (src/services/automations.ts switch).
 * Anything else falls through to the default branch and does nothing.
 */
export const EXECUTABLE_AUTOMATION_ACTIONS = [
  "notify",
  "notify_team",
  "pause_ai",
  "handover",
  "cancel_follow_ups",
  "send_follow_up",
  "schedule_follow_up",
  "change_stage",
  "mark_qualified",
  "mark_disqualified",
  "add_tag",
  "assign_owner",
  "send_booking_link",
  "send_message",
  "create_task",
] as const;

export function isExecutableAutomationAction(type: string | null | undefined): boolean {
  return Boolean(type) && (EXECUTABLE_AUTOMATION_ACTIONS as readonly string[]).includes(type as string);
}

/** Actions offered in the simple rule builder (all have executors and need no extra params). */
const ACTION_LABELS: Record<string, string> = {
  send_follow_up: "Send a follow-up message",
  schedule_follow_up: "Schedule a follow-up",
  send_booking_link: "Send a booking link",
  send_message: "Send a message",
  notify_team: "Notify the team",
  pause_ai: "Pause AI replies",
};

const OTHER_ACTION_LABELS: Record<string, string> = {
  notify: "Notify the team",
  handover: "Hand over to a person",
  cancel_follow_ups: "Cancel pending follow-ups",
  change_stage: "Move to a pipeline stage",
  mark_qualified: "Mark as qualified",
  mark_disqualified: "Mark as disqualified",
  add_tag: "Add a tag",
  assign_owner: "Assign an owner",
  create_task: "Create a task",
  publish_content: "Publish content",
  draft_reply_for_review: "Draft a reply for review",
};

/** Customer-facing automation trigger labels — never show raw enum keys. */
export function automationTriggerLabel(key: string | null | undefined): string {
  if (!key) return "Unknown trigger";
  if (isFiringAutomationTrigger(key)) return TRIGGER_LABELS[key as AutomationTrigger];
  return LEGACY_TRIGGER_LABELS[key] ?? humanizeKey(key);
}

/** Customer-facing automation action labels. */
export function automationActionLabel(key: string | null | undefined): string {
  if (!key) return "Unknown action";
  return ACTION_LABELS[key] ?? OTHER_ACTION_LABELS[key] ?? humanizeKey(key);
}

export const AUTOMATION_TRIGGER_OPTIONS = AUTOMATION_TRIGGERS.map((value) => ({
  value,
  label: TRIGGER_LABELS[value],
}));

export const AUTOMATION_ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({
  value,
  label,
}));
