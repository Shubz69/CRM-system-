/**
 * Go-live checklist items computed from real workspace state (no hardcoded "ready").
 * Pure functions so the rules are unit-testable; the page only fetches and renders.
 */

export type GoLiveCheck = {
  key: string;
  label: string;
  status: "ready" | "needs_attention" | "optional";
  detail: string;
};

/**
 * Active agent configuration as returned by GET /api/agent.
 * `undefined` = could not be loaded; `null` = the workspace has no active configuration.
 */
export type GoLiveAgentConfig =
  | {
      isDraft?: boolean | null;
      qualificationQuestions?: unknown;
      scoringRules?: unknown;
      optOutKeywords?: unknown;
      bookingUrl?: string | null;
    }
  | null
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

const AGENT_UNAVAILABLE = "Couldn't load AI Agent settings — open AI Agent to check";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function qualificationCheck(input: {
  agent: GoLiveAgentConfig;
  /** null when qualification fields could not be loaded. */
  qualificationFieldCount: number | null;
}): GoLiveCheck {
  const base = { key: "qualification", label: "Qualification" };
  const questions = nonEmptyStrings(input.agent?.qualificationQuestions).length;
  const fields = input.qualificationFieldCount ?? 0;
  if (questions > 0 || fields > 0) {
    return {
      ...base,
      status: "ready",
      detail: `${plural(fields, "qualification field")} · ${plural(questions, "question")}`,
    };
  }
  if (input.agent === undefined && input.qualificationFieldCount === null) {
    return { ...base, status: "needs_attention", detail: AGENT_UNAVAILABLE };
  }
  return {
    ...base,
    status: "needs_attention",
    detail: "Add qualification questions in AI Agent (or run the Setup Assistant)",
  };
}

export function scoringCheck(agent: GoLiveAgentConfig): GoLiveCheck {
  const base = { key: "scoring", label: "Lead Scoring" };
  if (agent === undefined) return { ...base, status: "needs_attention", detail: AGENT_UNAVAILABLE };
  if (agent === null) {
    return {
      ...base,
      status: "needs_attention",
      detail: "No active AI agent configuration — leads can't be scored",
    };
  }
  if (agent.isDraft) {
    return {
      ...base,
      status: "needs_attention",
      detail: "AI agent configuration is still a draft — publish it to score leads",
    };
  }
  const weights = isRecord(agent.scoringRules) ? agent.scoringRules.weights : undefined;
  const custom = isRecord(weights) && Object.keys(weights).length > 0;
  return {
    ...base,
    status: "ready",
    detail: custom ? "Custom scoring weights configured" : "Default scoring weights in use",
  };
}

export function messagingRulesCheck(agent: GoLiveAgentConfig): GoLiveCheck {
  const base = { key: "messaging", label: "Messaging rules" };
  if (agent === undefined) return { ...base, status: "needs_attention", detail: AGENT_UNAVAILABLE };
  // The inbound pipeline falls back to the default keywords when none are stored.
  if (!agent || !Array.isArray(agent.optOutKeywords)) {
    return { ...base, status: "ready", detail: "Default opt-out keywords (stop, unsubscribe, opt out)" };
  }
  const keywords = nonEmptyStrings(agent.optOutKeywords);
  if (keywords.length === 0) {
    return {
      ...base,
      status: "needs_attention",
      detail: "No opt-out keywords — contacts can't opt out by message. Add them in AI Agent",
    };
  }
  return { ...base, status: "ready", detail: `Opt-out keywords: ${keywords.slice(0, 5).join(", ")}` };
}

export function bookingCheck(input: {
  agent: GoLiveAgentConfig;
  /** DEFAULT_BOOKING_URL is configured on the platform. */
  defaultBookingUrlConfigured: boolean;
}): GoLiveCheck {
  const base = { key: "booking", label: "Booking" };
  // Same precedence as sending a booking link: workspace bookingUrl ?? DEFAULT_BOOKING_URL.
  if (input.agent?.bookingUrl?.trim()) {
    return { ...base, status: "ready", detail: "Workspace booking link set" };
  }
  if (input.defaultBookingUrlConfigured) {
    return { ...base, status: "ready", detail: "Using the default booking link" };
  }
  return { ...base, status: "optional", detail: "Add a booking URL in AI Agent before sending links" };
}

export function businessProfileCheck(input: {
  organisationName: string | null | undefined;
  /** null when the business profile could not be loaded. */
  productCount: number | null;
  audienceCount: number | null;
}): GoLiveCheck {
  const base = { key: "business", label: "Business profile" };
  const name = input.organisationName?.trim();
  if (!name) {
    return { ...base, status: "needs_attention", detail: "Set business name in Settings" };
  }
  if (input.productCount === null || input.audienceCount === null) {
    return { ...base, status: "needs_attention", detail: "Couldn't load the business profile" };
  }
  // The name exists from workspace creation — require real context beyond it.
  if (input.productCount + input.audienceCount === 0) {
    return {
      ...base,
      status: "needs_attention",
      detail: "Describe what you sell and who you serve (Onboarding or Business profile)",
    };
  }
  return {
    ...base,
    status: "ready",
    detail: `${name} · ${plural(input.productCount, "offering")} · ${plural(input.audienceCount, "audience")}`,
  };
}
