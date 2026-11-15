/**
 * Go-live checklist items computed from real workspace state (no hardcoded "ready").
 * Pure functions so the rules are unit-testable; the page only fetches and renders.
 */
import type { MemberRole } from "@prisma/client";
import { roleHasPermission, type Permission } from "@/lib/permissions";

export type GoLiveCheck = {
  key: string;
  label: string;
  /** "restricted": the signed-in role isn't allowed to read what this row needs. */
  status: "ready" | "needs_attention" | "optional" | "restricted";
  detail: string;
};

/**
 * Passed instead of data when the signed-in role may not call the endpoint behind it, so the
 * row can say "ask an owner or admin" rather than "couldn't load".
 */
export const NO_ACCESS = "no_access" as const;
export type NoAccess = typeof NO_ACCESS;

export const ASK_OWNER_TO_CHECK = "Ask a workspace owner or admin to check this";

function restricted(base: { key: string; label: string }, detail = ASK_OWNER_TO_CHECK): GoLiveCheck {
  return { ...base, status: "restricted", detail };
}

/**
 * Which go-live data sources the signed-in role may use. Each flag mirrors the check in the
 * API route behind it, so the page never calls an endpoint that answers 403.
 */
export function goLiveAccess(role: MemberRole | null | undefined) {
  const can = (permission: Permission) => (role ? roleHasPermission(role, permission) : false);
  return {
    /** GET /api/messaging-channels */
    channels: can("settings:read"),
    /** GET /api/integrations/zernio */
    socialAccounts: can("settings:read"),
    /** GET /api/integrations/manychat */
    manychat: can("integrations:manage"),
    /** GET /api/agent and GET /api/qualification-fields */
    agent: can("agent:manage"),
    /** GET /api/business-context */
    businessProfile: can("insights:read"),
    /** PATCH /api/autopilot (the "Turn Autopilot ON" button) */
    goLive: can("agent:manage"),
  };
}

export type GoLiveAccess = ReturnType<typeof goLiveAccess>;

/**
 * Active agent configuration as returned by GET /api/agent.
 * `undefined` = could not be loaded; `null` = the workspace has no active configuration;
 * NO_ACCESS = the signed-in role may not read it.
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
  | undefined
  | NoAccess;

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
  qualificationFieldCount: number | null | NoAccess;
}): GoLiveCheck {
  const base = { key: "qualification", label: "Qualification" };
  if (input.agent === NO_ACCESS || input.qualificationFieldCount === NO_ACCESS) {
    return restricted(base);
  }
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
  if (agent === NO_ACCESS) return restricted(base);
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
  if (agent === NO_ACCESS) return restricted(base);
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
  if (input.agent === NO_ACCESS) return restricted(base);
  // Same precedence as sending a booking link: workspace bookingUrl ?? DEFAULT_BOOKING_URL.
  if (input.agent?.bookingUrl?.trim()) {
    return { ...base, status: "ready", detail: "Workspace booking link set" };
  }
  if (input.defaultBookingUrlConfigured) {
    return { ...base, status: "ready", detail: "Using the default booking link" };
  }
  return { ...base, status: "optional", detail: "Add a booking URL in AI Agent before sending links" };
}

/** A MessagingChannel row as returned by GET /api/messaging-channels or /api/integrations/manychat. */
export type GoLiveMessagingChannel = {
  provider?: string | null;
  isActive?: boolean | null;
  displayName?: string | null;
  instagramUsername?: string | null;
};

function channelHandle(channel: GoLiveMessagingChannel | undefined): string | null {
  const username = channel?.instagramUsername?.trim().replace(/^@/, "");
  if (username) return `@${username}`;
  return channel?.displayName?.trim() || null;
}

function withHandle(path: string, handle: string | null | undefined): string {
  return handle ? `${path} (${handle})` : path;
}

/**
 * Instagram is ready when ANY inbound Instagram path is set up and working:
 *  - ManyChat: an active ManyChat channel plus the workspace webhook secret (both are required
 *    for /api/webhooks/manychat to accept a DM for this workspace);
 *  - Instagram (Meta): an active meta_instagram channel (only set active once the webhook
 *    subscription succeeded; disconnect deactivates it);
 *  - Zernio: a connected Instagram account in Social Accounts.
 */
/** GET /api/integrations/manychat body (the parts the checklist reads). */
export type GoLiveManyChatStatus = {
  secretConfigured?: boolean;
  apiTokenConfigured?: boolean;
  channels?: GoLiveMessagingChannel[];
};

/** GET /api/integrations/zernio `networks.instagram`. */
export type GoLiveZernioInstagram = {
  connected?: boolean;
  username?: string | null;
  displayName?: string | null;
  messaging?: { directMessages?: boolean };
};

export function instagramCheck(input: {
  /** GET /api/integrations/manychat body; null when it could not be loaded. */
  manychat: GoLiveManyChatStatus | null | NoAccess;
  /** GET /api/messaging-channels `channels`; null when they could not be loaded. */
  channels: GoLiveMessagingChannel[] | null | NoAccess;
  /** GET /api/integrations/zernio `networks.instagram`; null when it could not be loaded. */
  zernioInstagram: GoLiveZernioInstagram | null | NoAccess;
}): GoLiveCheck {
  const base = { key: "instagram", label: "Instagram" };
  if (
    input.manychat === NO_ACCESS &&
    input.channels === NO_ACCESS &&
    input.zernioInstagram === NO_ACCESS
  ) {
    return restricted(base);
  }
  // Roles that can read channels and Social Accounts but not ManyChat can't fix the setup either.
  const manyChatHidden = input.manychat === NO_ACCESS;
  const manychat = input.manychat === NO_ACCESS ? null : input.manychat;
  const channels = input.channels === NO_ACCESS ? null : input.channels;
  const zernioInstagram = input.zernioInstagram === NO_ACCESS ? null : input.zernioInstagram;

  const allChannels = [...(channels ?? []), ...(manychat?.channels ?? [])];
  const active = (provider: string) =>
    allChannels.filter((c) => c.provider === provider && c.isActive === true);

  const connected: string[] = [];
  const hints: string[] = [];
  let hintStatus: GoLiveCheck["status"] = "needs_attention";
  let replyHint: string | null = null;

  const manyChatActive = active("manychat");
  const manyChatSecret = manychat?.secretConfigured === true;
  if (manyChatActive.length > 0 && manyChatSecret) {
    connected.push(withHandle("ManyChat", channelHandle(manyChatActive[0])));
    if (manychat?.apiTokenConfigured === false) {
      replyHint = "add the ManyChat API token in Integrations so replies can be sent";
    }
  } else if (manyChatActive.length > 0 && manyChatHidden) {
    hints.push("ManyChat channel added — ask a workspace owner or admin to check its webhook secret");
    hintStatus = "restricted";
  } else if (manyChatActive.length > 0 && manychat === null) {
    hints.push("couldn't check the ManyChat webhook secret");
  } else if (manyChatActive.length > 0) {
    hints.push(
      "ManyChat channel added but no webhook secret — generate one in Integrations → Messaging setup",
    );
  } else if (manyChatSecret) {
    hints.push(
      "ManyChat webhook secret set but no active channel — add your Instagram channel in Integrations → Messaging setup",
    );
  }

  const metaActive = active("meta_instagram");
  if (metaActive.length > 0) {
    connected.push(withHandle("Instagram (Meta)", channelHandle(metaActive[0])));
  }

  const zernio = zernioInstagram;
  if (zernio?.connected && zernio.messaging?.directMessages !== false) {
    const handle = zernio.username?.trim()
      ? `@${zernio.username.trim().replace(/^@/, "")}`
      : zernio.displayName?.trim() || null;
    connected.push(withHandle("Zernio", handle));
  }

  if (connected.length > 0) {
    const extra = replyHint ? ` — ${replyHint}` : "";
    return { ...base, status: "ready", detail: `Receiving DMs via ${connected.join(" · ")}${extra}` };
  }
  if (hints.length > 0) {
    return { ...base, status: hintStatus, detail: capitalise(hints[0]!) };
  }
  if (manychat === null && channels === null && zernioInstagram === null) {
    return { ...base, status: "needs_attention", detail: "Couldn't load Instagram connections" };
  }
  return {
    ...base,
    status: "needs_attention",
    detail: manyChatHidden
      ? "No Instagram inbox connected — ask a workspace owner or admin to connect one in Integrations"
      : "No Instagram inbox connected — set up Messaging (ManyChat) or connect Instagram in Integrations",
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function businessProfileCheck(input: {
  organisationName: string | null | undefined;
  /** null when the business profile could not be loaded. */
  productCount: number | null | NoAccess;
  audienceCount: number | null | NoAccess;
}): GoLiveCheck {
  const base = { key: "business", label: "Business profile" };
  if (input.productCount === NO_ACCESS || input.audienceCount === NO_ACCESS) {
    return restricted(base);
  }
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
