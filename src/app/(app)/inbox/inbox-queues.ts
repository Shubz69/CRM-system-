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

/** Most conversations the list can load (matches MAX_LIMIT in /api/conversations). */
export const INBOX_LIST_MAX = 500;

/**
 * "Load more" while there are more conversations than are loaded, up to the server cap;
 * `capped` once the cap is reached and some conversations still aren't shown.
 */
export function inboxListPaging(input: { loaded: number; total: number; limit: number }): {
  canLoadMore: boolean;
  capped: boolean;
} {
  const more = input.loaded < input.total;
  const atCap = input.limit >= INBOX_LIST_MAX;
  return { canLoadMore: more && !atCap, capped: more && atCap };
}

type ThreadVersion = { activityVersion?: number | null; lastMessageAt?: string | null };

/** The open thread needs a full reload only when its activity version or last message moved. */
export function threadChanged(shown: ThreadVersion, latest: ThreadVersion): boolean {
  return (
    (shown.activityVersion ?? null) !== (latest.activityVersion ?? null) ||
    (shown.lastMessageAt ?? null) !== (latest.lastMessageAt ?? null)
  );
}

type AssignableMember = { id: string; name: string | null; email: string };

/**
 * Owner dropdown choices. With inbox:assign: anyone. Without it a person may only take an
 * unassigned conversation themselves or let go of their own — someone else's is shown locked.
 */
export function assigneeChoices(input: {
  canAssignAnyone: boolean;
  currentUserId: string | null;
  currentAssignee: AssignableMember | null;
  members: AssignableMember[];
}): { options: Array<{ value: string; label: string }>; locked: boolean } {
  const label = (m: AssignableMember) => m.name || m.email;
  if (input.canAssignAnyone) {
    return {
      options: [
        { value: "", label: "Unassigned" },
        ...input.members.map((m) => ({ value: m.id, label: label(m) })),
      ],
      locked: false,
    };
  }
  const assignee = input.currentAssignee;
  if (assignee && assignee.id !== input.currentUserId) {
    return { options: [{ value: assignee.id, label: label(assignee) }], locked: true };
  }
  return {
    options: [
      { value: "", label: "Unassigned" },
      ...(input.currentUserId ? [{ value: input.currentUserId, label: "Me" }] : []),
    ],
    locked: false,
  };
}

/** One key per composed reply: retries of the same message reuse it, a new message gets a new one. */
export function newReplyIdempotencyKey(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `inbox-reply:${id}`;
}
