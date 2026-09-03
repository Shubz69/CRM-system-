/** Instagram/ManyChat standard messaging window (24h from last user message). */
export const AUTOMATED_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Human agent window often extends to 7 days depending on product policies. */
export const HUMAN_MESSAGING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type MessagingWindowState = {
  lastInboundAt: Date | null;
  messagingWindowExpiresAt: Date | null;
  humanMessagingWindowExpiresAt: Date | null;
  automatedReplyAllowed: boolean;
  humanReplyAllowed: boolean;
  automatedBlockedReason: string | null;
  humanBlockedReason: string | null;
  automatedMsRemaining: number | null;
  humanMsRemaining: number | null;
};

export function computeWindowExpiry(lastInboundAt: Date, windowMs: number): Date {
  return new Date(lastInboundAt.getTime() + windowMs);
}

export function openMessagingWindows(lastInboundAt: Date = new Date()) {
  return {
    lastInboundAt,
    messagingWindowExpiresAt: computeWindowExpiry(lastInboundAt, AUTOMATED_MESSAGING_WINDOW_MS),
    humanMessagingWindowExpiresAt: computeWindowExpiry(lastInboundAt, HUMAN_MESSAGING_WINDOW_MS),
  };
}

export function evaluateMessagingWindow(input: {
  lastInboundAt?: Date | null;
  messagingWindowExpiresAt?: Date | null;
  humanMessagingWindowExpiresAt?: Date | null;
  aiPaused?: boolean;
  handlingMode?: string;
  optedOut?: boolean;
  now?: Date;
}): MessagingWindowState {
  const now = input.now ?? new Date();
  const autoExpiry = input.messagingWindowExpiresAt ?? null;
  const humanExpiry = input.humanMessagingWindowExpiresAt ?? null;

  let automatedBlockedReason: string | null = null;
  let humanBlockedReason: string | null = null;

  if (input.optedOut) {
    automatedBlockedReason = "Do not contact — customer opted out.";
    humanBlockedReason = "Do not contact — customer opted out.";
  } else {
    if (input.aiPaused || input.handlingMode === "HUMAN") {
      automatedBlockedReason = input.aiPaused
        ? "AI is paused for this conversation"
        : "Conversation is in human handling mode";
    } else if (!autoExpiry || autoExpiry.getTime() <= now.getTime()) {
      automatedBlockedReason = "Automated messaging window has closed";
    }

    if (!humanExpiry || humanExpiry.getTime() <= now.getTime()) {
      humanBlockedReason = "Human messaging window has closed";
    }
  }

  const automatedMsRemaining =
    autoExpiry && !automatedBlockedReason
      ? Math.max(0, autoExpiry.getTime() - now.getTime())
      : autoExpiry
        ? Math.max(0, autoExpiry.getTime() - now.getTime())
        : null;

  const humanMsRemaining =
    humanExpiry != null ? Math.max(0, humanExpiry.getTime() - now.getTime()) : null;

  return {
    lastInboundAt: input.lastInboundAt ?? null,
    messagingWindowExpiresAt: autoExpiry,
    humanMessagingWindowExpiresAt: humanExpiry,
    automatedReplyAllowed: automatedBlockedReason === null,
    humanReplyAllowed: humanBlockedReason === null,
    automatedBlockedReason,
    humanBlockedReason,
    automatedMsRemaining:
      autoExpiry != null ? Math.max(0, autoExpiry.getTime() - now.getTime()) : automatedMsRemaining,
    humanMsRemaining,
  };
}

export function formatDurationRemaining(ms: number | null): string {
  if (ms == null) return "Unknown";
  if (ms <= 0) return "Expired";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
