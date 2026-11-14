/** Inbox queue rules — shared by the inbox list and its tests. */

export const INBOX_QUEUES = ["all", "needs_reply", "hot", "human", "waiting"] as const;
export type InboxQueue = (typeof INBOX_QUEUES)[number];

/** `?queue=` from the URL (e.g. Home links to /inbox?queue=human); unknown values → "all". */
export function parseInboxQueue(value: string | null | undefined): InboxQueue {
  return (INBOX_QUEUES as readonly string[]).includes(value ?? "") ? (value as InboxQueue) : "all";
}

type QueueConversation = {
  unreadCount: number;
  aiPaused: boolean;
  needsHumanReview: boolean;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lead: { score: number } | null;
};

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The customer spoke last: their latest message is newer than our latest reply. */
export function conversationNeedsReply(c: Pick<QueueConversation, "lastInboundAt" | "lastOutboundAt">): boolean {
  const inbound = time(c.lastInboundAt);
  if (inbound == null) return false;
  const outbound = time(c.lastOutboundAt);
  return outbound == null || inbound > outbound;
}

export function matchesInboxQueue(c: QueueConversation, queue: InboxQueue): boolean {
  switch (queue) {
    case "human":
      return c.needsHumanReview || c.aiPaused;
    case "hot":
      return (c.lead?.score ?? 0) >= 70;
    case "needs_reply":
      return conversationNeedsReply(c);
    case "waiting":
      return !c.needsHumanReview && !c.aiPaused && c.unreadCount === 0;
    default:
      return true;
  }
}

/** One key per composed reply: retries of the same message reuse it, a new message gets a new one. */
export function newReplyIdempotencyKey(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `inbox-reply:${id}`;
}
